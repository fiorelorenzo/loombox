import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalExecutionTarget } from './local-execution-target';
import { computeWorktreeDiff, GitDiffError } from './git-diff';
import type { ExecutionTarget } from './target';

const execFileAsync = promisify(execFile);

describe('computeWorktreeDiff against a real local git repo (issue #206)', () => {
  let worktreePath: string;
  const target: ExecutionTarget = new LocalExecutionTarget();

  async function execGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: worktreePath });
    return stdout.trim();
  }

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'loombox-git-diff-'));
    await execGit(['init', '-q', '-b', 'main']);
    await execGit(['config', 'user.email', 'test@loombox.dev']);
    await execGit(['config', 'user.name', 'loombox test']);
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it('resolves an empty file list for a clean worktree', async () => {
    await writeFile(join(worktreePath, 'a.txt'), 'a\n');
    await execGit(['add', 'a.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);

    await expect(computeWorktreeDiff(target, worktreePath)).resolves.toEqual([]);
  });

  it('reports an unstaged modification with both sides of the diff', async () => {
    await writeFile(join(worktreePath, 'mod.txt'), 'line1\nline2\n');
    await execGit(['add', 'mod.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);
    await writeFile(join(worktreePath, 'mod.txt'), 'line1\nLINE2\n');

    const files = await computeWorktreeDiff(target, worktreePath);

    expect(files).toEqual([
      {
        path: 'mod.txt',
        previousPath: null,
        status: 'modified',
        oldText: 'line1\nline2\n',
        newText: 'line1\nLINE2\n',
      },
    ]);
  });

  it('reports a staged new file as added, with no previous content', async () => {
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial']);
    await writeFile(join(worktreePath, 'staged-new.txt'), 'brand new\n');
    await execGit(['add', 'staged-new.txt']);

    const files = await computeWorktreeDiff(target, worktreePath);

    expect(files).toEqual([
      {
        path: 'staged-new.txt',
        previousPath: null,
        status: 'added',
        oldText: null,
        newText: 'brand new\n',
      },
    ]);
  });

  it('reports an untracked file as added, exactly like a staged new file', async () => {
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial']);
    await writeFile(join(worktreePath, 'untracked.txt'), 'never added\n');

    const files = await computeWorktreeDiff(target, worktreePath);

    expect(files).toEqual([
      {
        path: 'untracked.txt',
        previousPath: null,
        status: 'added',
        oldText: null,
        newText: 'never added\n',
      },
    ]);
  });

  it('reports a deleted file with the old content and empty newText — never crashes reading a file that no longer exists', async () => {
    await writeFile(join(worktreePath, 'gone.txt'), 'will be deleted\n');
    await execGit(['add', 'gone.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);
    await unlink(join(worktreePath, 'gone.txt'));

    const files = await computeWorktreeDiff(target, worktreePath);

    expect(files).toEqual([
      {
        path: 'gone.txt',
        previousPath: null,
        status: 'deleted',
        oldText: 'will be deleted\n',
        newText: '',
      },
    ]);
  });

  it('reports a clean rename with previousPath set and the original content as oldText — never crashes on a moved path', async () => {
    await writeFile(
      join(worktreePath, 'original.txt'),
      'line1\nline2\nline3\nline4\nline5\n',
    );
    await execGit(['add', 'original.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);
    await execGit(['mv', 'original.txt', 'renamed.txt']);

    const files = await computeWorktreeDiff(target, worktreePath);

    expect(files).toEqual([
      {
        path: 'renamed.txt',
        previousPath: 'original.txt',
        status: 'renamed',
        oldText: 'line1\nline2\nline3\nline4\nline5\n',
        newText: 'line1\nline2\nline3\nline4\nline5\n',
      },
    ]);
  });

  it('collapses a modified binary file to the structural-only shape (oldText null, newText empty) — never crashes on binary content', async () => {
    await writeFile(join(worktreePath, 'bin.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    await execGit(['add', 'bin.bin']);
    await execGit(['commit', '-q', '-m', 'initial']);
    await writeFile(join(worktreePath, 'bin.bin'), Buffer.from([0x00, 0x02, 0x03, 0xff]));

    const files = await computeWorktreeDiff(target, worktreePath);

    expect(files).toEqual([
      { path: 'bin.bin', previousPath: null, status: 'modified', oldText: null, newText: '' },
    ]);
  });

  it('collapses a brand-new binary file to the structural-only shape too', async () => {
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial']);
    await writeFile(join(worktreePath, 'new.bin'), Buffer.from([0x00, 0x10, 0x20]));

    const files = await computeWorktreeDiff(target, worktreePath);

    expect(files).toEqual([
      { path: 'new.bin', previousPath: null, status: 'added', oldText: null, newText: '' },
    ]);
  });

  it('reports every changed file, not just one, for a worktree with several kinds of change at once', async () => {
    await writeFile(join(worktreePath, 'stays-modified.txt'), 'v1\n');
    await execGit(['add', 'stays-modified.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);
    await writeFile(join(worktreePath, 'stays-modified.txt'), 'v2\n');
    await writeFile(join(worktreePath, 'brand-new.txt'), 'new\n');

    const files = await computeWorktreeDiff(target, worktreePath);

    expect(files.map((f) => f.path).sort()).toEqual(['brand-new.txt', 'stays-modified.txt']);
  });

  it('throws GitDiffError for a worktree that is not a git repository at all — never crashes uncaught', async () => {
    const plainDir = await mkdtemp(join(tmpdir(), 'loombox-git-diff-not-a-repo-'));
    try {
      await mkdir(join(plainDir, 'sub'), { recursive: true });
      await expect(computeWorktreeDiff(target, plainDir)).rejects.toThrow(GitDiffError);
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });
});

describe('computeWorktreeDiff when git itself cannot be run (issue #206)', () => {
  it('throws GitDiffError rather than letting the exec rejection escape uncaught', async () => {
    const brokenTarget: ExecutionTarget = {
      kind: 'local',
      exec: () => Promise.reject(new Error('spawn git ENOENT')),
      readFile: () => Promise.reject(new Error('not implemented')),
      writeFile: () => Promise.reject(new Error('not implemented')),
      mkdir: () => Promise.reject(new Error('not implemented')),
      readdir: () => Promise.reject(new Error('not implemented')),
      readdirDetailed: () => Promise.reject(new Error('not implemented')),
    };

    await expect(computeWorktreeDiff(brokenTarget, '/some/worktree')).rejects.toThrow(
      GitDiffError,
    );
  });
});
