import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  isDockerAvailable,
  startDockerSshdFixture,
  type DockerSshdFixture,
} from './docker-sshd-fixture';
import { LocalProcessTransport } from './local-process-transport';
import { listRemoteDir, RemoteFsError, statRemotePath } from './remote-fs';
import { Ssh2Transport } from './ssh2-transport';

// Exercised for real against `LocalProcessTransport` (a real child-process
// "remote" on this machine, so `stat -c`'s exact flags/format are proven for
// real) — see that transport's own doc comment for why this is preferred
// over a scripted fake for this module.
describe('remote-fs (hermetic, via LocalProcessTransport)', () => {
  let dir: string;
  let transport: LocalProcessTransport;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loombox-remote-fs-'));
    transport = new LocalProcessTransport();
    await transport.connect();
  });

  afterEach(async () => {
    await transport.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe('statRemotePath', () => {
    it('stats a regular file', async () => {
      const filePath = join(dir, 'note.txt');
      await writeFile(filePath, 'hello world');

      const result = await statRemotePath(transport, filePath);
      expect(result.type).toBe('file');
      expect(result.size).toBe(11);
      expect(result.mtimeMs).toBeGreaterThan(0);
    });

    it('stats a directory', async () => {
      const subdir = join(dir, 'sub');
      await mkdir(subdir);

      const result = await statRemotePath(transport, subdir);
      expect(result.type).toBe('dir');
    });

    it('stats a symlink', async () => {
      const target = join(dir, 'target.txt');
      await writeFile(target, 'x');
      const link = join(dir, 'link.txt');
      await symlink(target, link);

      const result = await statRemotePath(transport, link);
      expect(result.type).toBe('symlink');
    });

    it('throws a RemoteFsError with code ENOENT for a missing path', async () => {
      const missing = join(dir, 'does-not-exist');
      const error = await statRemotePath(transport, missing).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RemoteFsError);
      expect((error as RemoteFsError).code).toBe('ENOENT');
      expect((error as RemoteFsError).path).toBe(missing);
    });

    it('throws a RemoteFsError with code EACCES for a permission-denied path', async () => {
      const restrictedDir = join(dir, 'restricted');
      await mkdir(restrictedDir);
      const innerFile = join(restrictedDir, 'secret.txt');
      await writeFile(innerFile, 'shh');
      const { chmod } = await import('node:fs/promises');
      await chmod(restrictedDir, 0o000);

      try {
        // Running as a non-root user this actually triggers EACCES on the
        // stat itself when the directory has no execute bit. (Running as
        // root — e.g. some CI containers — bypasses the permission check
        // entirely, so this assertion is skipped in that case.)
        if (process.getuid?.() === 0) return;

        const error = await statRemotePath(transport, innerFile).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RemoteFsError);
        expect((error as RemoteFsError).code).toBe('EACCES');
      } finally {
        await chmod(restrictedDir, 0o700);
      }
    });
  });

  describe('listRemoteDir', () => {
    it('lists files, directories, and a dotfile with type/size/mtime', async () => {
      await writeFile(join(dir, 'a.txt'), 'aaa');
      await writeFile(join(dir, '.hidden'), 'h');
      await mkdir(join(dir, 'sub'));

      const entries = await listRemoteDir(transport, dir);
      const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

      expect(Object.keys(byName).sort()).toEqual(['.hidden', 'a.txt', 'sub']);
      expect(byName['a.txt'].type).toBe('file');
      expect(byName['a.txt'].size).toBe(3);
      expect(byName['.hidden'].type).toBe('file');
      expect(byName['sub'].type).toBe('dir');
      for (const entry of entries) {
        expect(entry.mtimeMs).toBeGreaterThan(0);
      }
    });

    it('returns an empty list for an empty directory', async () => {
      const empty = join(dir, 'empty');
      await mkdir(empty);
      await expect(listRemoteDir(transport, empty)).resolves.toEqual([]);
    });

    it('throws RemoteFsError ENOENT for a missing directory', async () => {
      const error = await listRemoteDir(transport, join(dir, 'nope')).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RemoteFsError);
      expect((error as RemoteFsError).code).toBe('ENOENT');
    });

    it('throws RemoteFsError ENOTDIR when the path is a file, not a directory', async () => {
      const filePath = join(dir, 'file.txt');
      await writeFile(filePath, 'x');

      const error = await listRemoteDir(transport, filePath).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RemoteFsError);
      expect((error as RemoteFsError).code).toBe('ENOTDIR');
    });
  });
});

// Real-sshd integration (issue #74's "Integration tests run against the
// Dockerized SSH fixture"), gated on Docker actually being reachable.
const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)('remote-fs (Dockerized sshd fixture, issue #70/#74)', () => {
  let fixture: DockerSshdFixture;
  let transport: Ssh2Transport;

  beforeAll(async () => {
    fixture = await startDockerSshdFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.stop();
  }, 30_000);

  beforeEach(async () => {
    transport = new Ssh2Transport({
      host: fixture.host,
      port: fixture.port,
      username: fixture.username,
      privateKeyPath: fixture.privateKeyPath,
    });
    await transport.connect();
  });

  afterEach(async () => {
    await transport.close();
  });

  it('lists the fixture repo directory over a real sshd', async () => {
    const entries = await listRemoteDir(transport, fixture.remoteRepoPath);
    expect(entries.some((e) => e.name === '.git' && e.type === 'dir')).toBe(true);
  });

  it('stats a path that does not exist on the remote host', async () => {
    const error = await statRemotePath(transport, '/does/not/exist').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteFsError);
    expect((error as RemoteFsError).code).toBe('ENOENT');
  });
});
