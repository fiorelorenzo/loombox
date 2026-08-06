import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalExecutionTarget } from './local-execution-target';
import {
  applyGitHunkAction,
  computeHunkDiff,
  computeWorktreeDiff,
  GitDiffError,
  GitHunkActionError,
} from './git-diff';
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
    await writeFile(join(worktreePath, 'original.txt'), 'line1\nline2\nline3\nline4\nline5\n');
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

    await expect(computeWorktreeDiff(brokenTarget, '/some/worktree')).rejects.toThrow(GitDiffError);
  });
});

describe('computeHunkDiff / applyGitHunkAction against a real local git repo (issue #232)', () => {
  let worktreePath: string;
  const target: ExecutionTarget = new LocalExecutionTarget();

  async function execGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: worktreePath });
    return stdout.trim();
  }

  async function readWorktree(relPath: string): Promise<string> {
    return readFile(join(worktreePath, relPath), 'utf8');
  }

  /** `git show :<relPath>` — the exact index (staged) content, independent of both `HEAD` and the worktree. */
  async function readIndex(relPath: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['show', `:${relPath}`], { cwd: worktreePath });
    return stdout;
  }

  /** 20 numbered lines — far enough apart that two edits near the top and bottom never merge into one `git diff -U3` hunk (git's own default 3-line context only merges hunks whose context windows overlap). */
  function numberedLines(count: number): string {
    return Array.from({ length: count }, (_, i) => `line${i + 1}`).join('\n') + '\n';
  }

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'loombox-git-hunks-'));
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

    await expect(computeHunkDiff(target, worktreePath)).resolves.toEqual([]);
  });

  it('reports an untracked file as one synthetic unstaged hunk, staged empty', async () => {
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial']);
    await writeFile(join(worktreePath, 'untracked.txt'), 'brand new\ncontent\n');

    const files = await computeHunkDiff(target, worktreePath);

    expect(files).toEqual([
      {
        path: 'untracked.txt',
        previousPath: null,
        status: 'added',
        staged: [],
        unstaged: [
          {
            header: '@@ -0,0 +1,2 @@',
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 2,
            lines: [
              { kind: 'added', text: 'brand new' },
              { kind: 'added', text: 'content' },
            ],
          },
        ],
      },
    ]);
  });

  it('reports a fully staged new file as one staged hunk, unstaged empty', async () => {
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial']);
    await writeFile(join(worktreePath, 'staged-new.txt'), 'first\nsecond\n');
    await execGit(['add', 'staged-new.txt']);

    const files = await computeHunkDiff(target, worktreePath);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('staged-new.txt');
    expect(files[0]?.status).toBe('added');
    expect(files[0]?.unstaged).toEqual([]);
    expect(files[0]?.staged).toHaveLength(1);
    expect(files[0]?.staged[0]?.lines).toEqual([
      { kind: 'added', text: 'first' },
      { kind: 'added', text: 'second' },
    ]);
  });

  it('reports a two-hunk unstaged file as two separate hunks, each with only its own changed lines', async () => {
    await writeFile(join(worktreePath, 'multi.txt'), numberedLines(20));
    await execGit(['add', 'multi.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);
    const edited = numberedLines(20).replace('line2', 'LINE2').replace('line18', 'LINE18');
    await writeFile(join(worktreePath, 'multi.txt'), edited);

    const files = await computeHunkDiff(target, worktreePath);

    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.staged).toEqual([]);
    expect(file.unstaged).toHaveLength(2);
    expect(file.unstaged[0]?.lines).toContainEqual({ kind: 'added', text: 'LINE2' });
    expect(file.unstaged[0]?.lines).toContainEqual({ kind: 'removed', text: 'line2' });
    expect(file.unstaged[1]?.lines).toContainEqual({ kind: 'added', text: 'LINE18' });
    expect(file.unstaged[1]?.lines).toContainEqual({ kind: 'removed', text: 'line18' });
  });

  it('reports a partially staged file with the staged hunk on one side and the remaining hunk on the other', async () => {
    await writeFile(join(worktreePath, 'multi.txt'), numberedLines(20));
    await execGit(['add', 'multi.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);
    const edited = numberedLines(20).replace('line2', 'LINE2').replace('line18', 'LINE18');
    await writeFile(join(worktreePath, 'multi.txt'), edited);

    await applyGitHunkAction(target, worktreePath, {
      path: 'multi.txt',
      hunkIndex: 0,
      action: 'stage',
    });

    const files = await computeHunkDiff(target, worktreePath);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.staged).toHaveLength(1);
    expect(file.staged[0]?.lines).toContainEqual({ kind: 'added', text: 'LINE2' });
    expect(file.unstaged).toHaveLength(1);
    expect(file.unstaged[0]?.lines).toContainEqual({ kind: 'added', text: 'LINE18' });

    // The index now holds exactly the first edit; the worktree still holds both.
    expect(await readIndex('multi.txt')).toBe(edited.replace('LINE18', 'line18'));
    expect(await readWorktree('multi.txt')).toBe(edited);
  });

  it('stage then unstage a hunk round-trips the index back to its original content, worktree untouched throughout', async () => {
    await writeFile(join(worktreePath, 'single.txt'), 'a\nb\nc\n');
    await execGit(['add', 'single.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);
    await writeFile(join(worktreePath, 'single.txt'), 'a\nB\nc\n');

    await applyGitHunkAction(target, worktreePath, {
      path: 'single.txt',
      hunkIndex: 0,
      action: 'stage',
    });
    expect(await readIndex('single.txt')).toBe('a\nB\nc\n');
    expect(await readWorktree('single.txt')).toBe('a\nB\nc\n');

    let files = await computeHunkDiff(target, worktreePath);
    expect(files[0]?.staged).toHaveLength(1);
    expect(files[0]?.unstaged).toEqual([]);

    await applyGitHunkAction(target, worktreePath, {
      path: 'single.txt',
      hunkIndex: 0,
      action: 'unstage',
    });
    expect(await readIndex('single.txt')).toBe('a\nb\nc\n');
    // Unstage never touches the worktree — the edit is still sitting there, unstaged again.
    expect(await readWorktree('single.txt')).toBe('a\nB\nc\n');

    files = await computeHunkDiff(target, worktreePath);
    expect(files[0]?.staged).toEqual([]);
    expect(files[0]?.unstaged).toHaveLength(1);
  });

  it('discards one hunk of a multi-hunk file, reverting only that hunk\u2019s lines in the worktree and leaving the other hunk\u2019s edit intact', async () => {
    await writeFile(join(worktreePath, 'multi.txt'), numberedLines(20));
    await execGit(['add', 'multi.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);
    const edited = numberedLines(20).replace('line2', 'LINE2').replace('line18', 'LINE18');
    await writeFile(join(worktreePath, 'multi.txt'), edited);

    await applyGitHunkAction(target, worktreePath, {
      path: 'multi.txt',
      hunkIndex: 0,
      action: 'discard',
    });

    const expected = numberedLines(20).replace('line18', 'LINE18');
    expect(await readWorktree('multi.txt')).toBe(expected);
    // Nothing was ever staged, so the index still matches HEAD exactly.
    expect(await readIndex('multi.txt')).toBe(numberedLines(20));

    const files = await computeHunkDiff(target, worktreePath);
    expect(files[0]?.staged).toEqual([]);
    expect(files[0]?.unstaged).toHaveLength(1);
    expect(files[0]?.unstaged[0]?.lines).toContainEqual({ kind: 'added', text: 'LINE18' });
  });

  it('discards a deletion hunk, restoring the deleted file to its committed content', async () => {
    await writeFile(join(worktreePath, 'gone.txt'), 'keep me\n');
    await execGit(['add', 'gone.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);
    await unlink(join(worktreePath, 'gone.txt'));

    await applyGitHunkAction(target, worktreePath, {
      path: 'gone.txt',
      hunkIndex: 0,
      action: 'discard',
    });

    expect(await readWorktree('gone.txt')).toBe('keep me\n');
    await expect(computeHunkDiff(target, worktreePath)).resolves.toEqual([]);
  });

  it('stages an untracked file with git add, landing its full content in the index without touching the worktree', async () => {
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial']);
    await writeFile(join(worktreePath, 'new.txt'), 'hello\n');

    await applyGitHunkAction(target, worktreePath, {
      path: 'new.txt',
      hunkIndex: 0,
      action: 'stage',
    });

    expect(await readIndex('new.txt')).toBe('hello\n');
    expect(await execGit(['status', '--porcelain'])).toBe('A  new.txt');
  });

  it('discards an untracked file by deleting it — unrecoverable, matching DiscardHunkDialog\u2019s own confirmation copy', async () => {
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial']);
    await writeFile(join(worktreePath, 'scratch.txt'), 'temporary\n');

    await applyGitHunkAction(target, worktreePath, {
      path: 'scratch.txt',
      hunkIndex: 0,
      action: 'discard',
    });

    await expect(readWorktree('scratch.txt')).rejects.toThrow();
    await expect(computeHunkDiff(target, worktreePath)).resolves.toEqual([]);
  });

  it('throws GitHunkActionError for an out-of-range hunkIndex rather than applying the wrong hunk', async () => {
    await writeFile(join(worktreePath, 'single.txt'), 'a\nb\n');
    await execGit(['add', 'single.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);
    await writeFile(join(worktreePath, 'single.txt'), 'a\nB\n');

    await expect(
      applyGitHunkAction(target, worktreePath, {
        path: 'single.txt',
        hunkIndex: 3,
        action: 'stage',
      }),
    ).rejects.toThrow(GitHunkActionError);
    // Nothing was mutated by the failed attempt.
    expect(await readWorktree('single.txt')).toBe('a\nB\n');
    expect(await readIndex('single.txt')).toBe('a\nb\n');
  });

  it('throws GitHunkActionError unstaging a file with no staged changes', async () => {
    await writeFile(join(worktreePath, 'single.txt'), 'a\nb\n');
    await execGit(['add', 'single.txt']);
    await execGit(['commit', '-q', '-m', 'initial']);
    await writeFile(join(worktreePath, 'single.txt'), 'a\nB\n');

    await expect(
      applyGitHunkAction(target, worktreePath, {
        path: 'single.txt',
        hunkIndex: 0,
        action: 'unstage',
      }),
    ).rejects.toThrow(GitHunkActionError);
  });

  it('throws GitHunkActionError unstaging an untracked file (it has no staged side at all)', async () => {
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial']);
    await writeFile(join(worktreePath, 'new.txt'), 'hello\n');

    await expect(
      applyGitHunkAction(target, worktreePath, {
        path: 'new.txt',
        hunkIndex: 0,
        action: 'unstage',
      }),
    ).rejects.toThrow(GitHunkActionError);
  });

  it('throws GitHunkActionError for a non-zero hunkIndex against an untracked file\u2019s single synthetic hunk', async () => {
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial']);
    await writeFile(join(worktreePath, 'new.txt'), 'hello\n');

    await expect(
      applyGitHunkAction(target, worktreePath, { path: 'new.txt', hunkIndex: 1, action: 'stage' }),
    ).rejects.toThrow(GitHunkActionError);
  });

  it('throws GitDiffError for computeHunkDiff against a worktree that is not a git repository at all', async () => {
    const plainDir = await mkdtemp(join(tmpdir(), 'loombox-git-hunks-not-a-repo-'));
    try {
      await expect(computeHunkDiff(target, plainDir)).rejects.toThrow(GitDiffError);
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });
});
