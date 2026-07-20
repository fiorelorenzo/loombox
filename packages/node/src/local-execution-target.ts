import { spawn } from 'node:child_process';
import {
  lstat as fsLstat,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type {
  DetailedDirEntry,
  ExecOptions,
  ExecResult,
  ExecutionTarget,
  FsEntryType,
} from './target';

/** Maps a Node `Dirent`'s type-test methods to {@link FsEntryType} — mirrors `./ssh/remote-fs.ts`'s `mapType` for the local target. */
function directoryEntryType(dirent: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FsEntryType {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'file';
}

/**
 * The `local` implementation of {@link ExecutionTarget} (issue #69): runs the
 * agent/exec commands and touches the filesystem directly on the machine
 * this node itself runs on, via `node:child_process`/`node:fs` — no shell
 * involved (`child_process.spawn` with an argv array, not `sh -c`), so
 * neither `command` nor `args` need any quoting from this class or its
 * caller.
 */
export class LocalExecutionTarget implements ExecutionTarget {
  readonly kind = 'local' as const;

  exec(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : undefined,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      // e.g. ENOENT for a command that doesn't exist — the process never
      // started, so there is no exit code to report; reject rather than
      // synthesize one.
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      });

      if (options.input !== undefined) {
        child.stdin.write(options.input);
      }
      child.stdin.end();
    });
  }

  async readFile(path: string): Promise<string> {
    return fsReadFile(path, 'utf8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fsWriteFile(path, content, 'utf8');
  }

  async mkdir(path: string): Promise<void> {
    await fsMkdir(path, { recursive: true });
  }

  async readdir(path: string): Promise<string[]> {
    return fsReaddir(path);
  }

  /** Richer local directory browsing (issue #74/#171 parity with {@link SshExecutionTarget.readdirDetailed}): every entry's type/size/mtime. `lstat` (not `stat`) reports a symlink's own metadata rather than following it, matching this method's `'symlink'` type classification. */
  async readdirDetailed(path: string): Promise<DetailedDirEntry[]> {
    const dirents = await fsReaddir(path, { withFileTypes: true });
    return Promise.all(
      dirents.map(async (dirent) => {
        const entryPath = join(path, dirent.name);
        const stats = await fsLstat(entryPath);
        return {
          name: dirent.name,
          type: directoryEntryType(dirent),
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        };
      }),
    );
  }
}
