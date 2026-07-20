import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalProcessTransport } from './ssh/local-process-transport';
import { SshExecutionTarget } from './ssh-execution-target';

// Exercised against LocalProcessTransport — a real child-process "remote"
// running on this machine (see its own doc comment) — so every shell command
// this class builds is proven for real, not against a mock of exec().

describe('SshExecutionTarget', () => {
  let dir: string;
  let transport: LocalProcessTransport;
  let target: SshExecutionTarget;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loombox-ssh-target-'));
    transport = new LocalProcessTransport();
    await transport.connect();
    target = new SshExecutionTarget(transport);
  });

  afterEach(async () => {
    await transport.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports its kind as "ssh"', () => {
    expect(target.kind).toBe('ssh');
  });

  describe('exec', () => {
    it('runs a command and captures stdout/exitCode', async () => {
      const result = await target.exec('echo', ['hello world']);
      expect(result.stdout).toBe('hello world\n');
      expect(result.exitCode).toBe(0);
    });

    it('resolves (not rejects) with a non-zero exit code', async () => {
      const result = await target.exec('sh', ['-c', 'exit 9']);
      expect(result.exitCode).toBe(9);
    });

    it('runs the command in the given cwd', async () => {
      await target.writeFile(join(dir, 'marker.txt'), 'found me');
      const result = await target.exec('cat', ['marker.txt'], { cwd: dir });
      expect(result.stdout).toBe('found me');
      expect(result.exitCode).toBe(0);
    });

    it('delivers options.input on stdin', async () => {
      const result = await target.exec('cat', [], { input: 'piped in' });
      expect(result.stdout).toBe('piped in');
    });

    it('safely quotes arguments containing spaces and shell metacharacters', async () => {
      const trickyName = "weird ' && ; name.txt";
      await target.writeFile(join(dir, trickyName), 'ok');
      const entries = await target.readdir(dir);
      expect(entries).toEqual([trickyName]);
    });
  });

  describe('filesystem operations', () => {
    it('writes then reads back a file', async () => {
      const filePath = join(dir, 'note.txt');
      await target.writeFile(filePath, 'hello world');
      await expect(target.readFile(filePath)).resolves.toBe('hello world');
    });

    it('rejects readFile for a file that does not exist', async () => {
      await expect(target.readFile(join(dir, 'missing.txt'))).rejects.toThrow(/readFile/);
    });

    it('creates nested directories via mkdir -p', async () => {
      const nested = join(dir, 'a', 'b', 'c');
      await target.mkdir(nested);
      await target.writeFile(join(nested, 'f.txt'), 'x');
      await expect(target.readFile(join(nested, 'f.txt'))).resolves.toBe('x');
    });

    it('lists directory entries via readdir', async () => {
      await target.writeFile(join(dir, 'one.txt'), '1');
      await target.writeFile(join(dir, 'two.txt'), '2');
      const entries = await target.readdir(dir);
      expect(entries.sort()).toEqual(['one.txt', 'two.txt']);
    });

    it('rejects readdir for a directory that does not exist', async () => {
      await expect(target.readdir(join(dir, 'does-not-exist'))).rejects.toThrow(/readdir/);
    });
  });
});
