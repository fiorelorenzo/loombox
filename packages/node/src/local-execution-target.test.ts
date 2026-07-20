import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalExecutionTarget } from './local-execution-target';

describe('LocalExecutionTarget', () => {
  let dir: string;
  let target: LocalExecutionTarget;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loombox-local-target-'));
    target = new LocalExecutionTarget();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports its kind as "local"', () => {
    expect(target.kind).toBe('local');
  });

  describe('exec', () => {
    it('runs a command and captures stdout/stderr/exitCode', async () => {
      const result = await target.exec(process.execPath, [
        '-e',
        "process.stdout.write('out'); process.stderr.write('err'); process.exit(0)",
      ]);
      expect(result.stdout).toBe('out');
      expect(result.stderr).toBe('err');
      expect(result.exitCode).toBe(0);
    });

    it('resolves (not rejects) with a non-zero exit code', async () => {
      const result = await target.exec(process.execPath, ['-e', 'process.exit(7)']);
      expect(result.exitCode).toBe(7);
    });

    it('runs the command in the given cwd', async () => {
      const result = await target.exec(
        process.execPath,
        ['-e', 'process.stdout.write(process.cwd())'],
        {
          cwd: dir,
        },
      );
      // Resolve both sides through fs realpath-equivalent (macOS /tmp is a
      // symlink to /private/tmp; not an issue on this Linux devbox, but
      // comparing the raw string is fine here since dir is not itself
      // going through a symlinked tmpdir on this platform).
      expect(result.stdout).toBe(dir);
    });

    it('delivers options.input on stdin and closes it', async () => {
      const result = await target.exec('cat', [], { input: 'hello from stdin' });
      expect(result.stdout).toBe('hello from stdin');
      expect(result.exitCode).toBe(0);
    });

    it('rejects when the command cannot be started at all', async () => {
      await expect(target.exec('loombox-definitely-not-a-real-binary-xyz', [])).rejects.toThrow();
    });
  });

  describe('filesystem operations', () => {
    it('writes then reads back a file', async () => {
      const filePath = join(dir, 'note.txt');
      await target.writeFile(filePath, 'hello world');
      await expect(target.readFile(filePath)).resolves.toBe('hello world');
    });

    it('rejects readFile for a file that does not exist', async () => {
      await expect(target.readFile(join(dir, 'missing.txt'))).rejects.toThrow();
    });

    it('creates nested directories via mkdir (like mkdir -p)', async () => {
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
      await expect(target.readdir(join(dir, 'does-not-exist'))).rejects.toThrow();
    });

    describe('readdirDetailed (issue #74/#171)', () => {
      it('reports type/size/mtime for each entry', async () => {
        await target.writeFile(join(dir, 'a.txt'), 'aaa');
        await target.mkdir(join(dir, 'sub'));

        const entries = await target.readdirDetailed(dir);
        const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
        expect(byName['a.txt']).toMatchObject({ type: 'file', size: 3 });
        expect(byName['sub']).toMatchObject({ type: 'dir' });
        expect(byName['a.txt'].mtimeMs).toBeGreaterThan(0);
      });

      it('rejects for a directory that does not exist', async () => {
        await expect(target.readdirDetailed(join(dir, 'does-not-exist'))).rejects.toThrow();
      });
    });
  });
});
