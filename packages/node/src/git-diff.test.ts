import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalExecutionTarget } from './local-execution-target';
import {
  abortMerge,
  applyGitHunkAction,
  computeHunkDiff,
  computeWorktreeDiff,
  createBranch,
  GitBranchActionError,
  GitBranchAlreadyExistsError,
  GitBranchError,
  GitBranchNotFoundError,
  GitDiffError,
  GitDirtyWorktreeError,
  GitHunkActionError,
  GitMergeConflictError,
  GitPushAuthenticationError,
  GitPushNonFastForwardError,
  GitPushStaleLeaseError,
  GitStashNotFoundError,
  GitStashPopConflictError,
  listBranches,
  listStashes,
  mergeBranch,
  pushBranch,
  stashDrop,
  stashPop,
  stashSave,
  switchBranch,
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

describe('branch create/switch/merge/abort against a real local git repo (issue #234)', () => {
  let worktreePath: string;
  const target: ExecutionTarget = new LocalExecutionTarget();

  async function execGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: worktreePath });
    return stdout.trim();
  }

  async function currentBranch(): Promise<string> {
    return execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'loombox-git-branch-'));
    await execGit(['init', '-q', '-b', 'main']);
    await execGit(['config', 'user.email', 'test@loombox.dev']);
    await execGit(['config', 'user.name', 'loombox test']);
    await writeFile(join(worktreePath, 'f.txt'), 'base\n');
    await execGit(['add', 'f.txt']);
    await execGit(['commit', '-q', '-m', 'base']);
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  describe('listBranches', () => {
    it('reports the sole branch as current for a freshly-initialized repo', async () => {
      const branches = await listBranches(target, worktreePath);
      expect(branches).toEqual([{ name: 'main', current: true }]);
    });

    it('reports every local branch, only the checked-out one flagged current', async () => {
      await execGit(['branch', 'feature-a']);
      await execGit(['branch', 'feature-b']);
      const branches = await listBranches(target, worktreePath);
      expect(branches.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'feature-a', current: false },
        { name: 'feature-b', current: false },
        { name: 'main', current: true },
      ]);
    });

    it('excludes the synthetic detached-HEAD pseudo-entry rather than reporting a branch literally named "(HEAD..."', async () => {
      const sha = await execGit(['rev-parse', 'HEAD']);
      await execGit(['checkout', '-q', sha]);
      const branches = await listBranches(target, worktreePath);
      expect(branches).toEqual([{ name: 'main', current: false }]);
    });

    it('throws GitBranchError for a worktree that is not a git repository at all', async () => {
      const plainDir = await mkdtemp(join(tmpdir(), 'loombox-git-branch-not-a-repo-'));
      try {
        await expect(listBranches(target, plainDir)).rejects.toThrow(GitBranchError);
      } finally {
        await rm(plainDir, { recursive: true, force: true });
      }
    });
  });

  describe('createBranch', () => {
    it('creates a branch off HEAD without switching to it — real git state proves both', async () => {
      await createBranch(target, worktreePath, { name: 'feature', startPoint: null });
      const branches = await execGit(['branch', '--list']);
      expect(branches).toContain('feature');
      await expect(currentBranch()).resolves.toBe('main');
    });

    it('creates a branch off an explicit start point, not HEAD', async () => {
      await writeFile(join(worktreePath, 'g.txt'), 'g\n');
      await execGit(['add', 'g.txt']);
      await execGit(['commit', '-q', '-m', 'second commit']);
      const firstSha = await execGit(['rev-parse', 'HEAD~1']);

      await createBranch(target, worktreePath, { name: 'from-first', startPoint: firstSha });
      const branchSha = await execGit(['rev-parse', 'from-first']);
      expect(branchSha).toBe(firstSha);
    });

    it('throws GitBranchAlreadyExistsError for a name already taken — never silently no-ops', async () => {
      await execGit(['branch', 'dupe']);
      await expect(
        createBranch(target, worktreePath, { name: 'dupe', startPoint: null }),
      ).rejects.toThrow(GitBranchAlreadyExistsError);
    });
  });

  describe('switchBranch', () => {
    it('switches the real checked-out branch — HEAD genuinely moves', async () => {
      await execGit(['branch', 'feature']);
      await switchBranch(target, worktreePath, { name: 'feature' });
      await expect(currentBranch()).resolves.toBe('feature');
    });

    it('throws GitBranchNotFoundError for a name matching no branch, and never moves HEAD', async () => {
      await expect(switchBranch(target, worktreePath, { name: 'no-such-branch' })).rejects.toThrow(
        GitBranchNotFoundError,
      );
      await expect(currentBranch()).resolves.toBe('main');
    });

    it('throws GitDirtyWorktreeError with the real conflicting path when switching would overwrite local changes, and leaves the worktree exactly where it was', async () => {
      await execGit(['checkout', '-q', '-b', 'other']);
      await writeFile(join(worktreePath, 'f.txt'), 'other-branch-version\n');
      await execGit(['commit', '-q', '-am', 'other branch change']);
      await execGit(['checkout', '-q', 'main']);
      await writeFile(join(worktreePath, 'f.txt'), 'uncommitted-dirty-version\n');

      let caught: unknown;
      try {
        await switchBranch(target, worktreePath, { name: 'other' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitDirtyWorktreeError);
      expect((caught as InstanceType<typeof GitDirtyWorktreeError>).paths).toEqual(['f.txt']);
      // The worktree is genuinely untouched: still on main, still dirty with
      // the uncommitted content — never a partial/corrupted checkout.
      await expect(currentBranch()).resolves.toBe('main');
      await expect(readFile(join(worktreePath, 'f.txt'), 'utf8')).resolves.toBe(
        'uncommitted-dirty-version\n',
      );
    });
  });

  describe('mergeBranch', () => {
    it('fast-forwards when the target branch is a strict descendant — real HEAD lands on its tip', async () => {
      await execGit(['checkout', '-q', '-b', 'feature']);
      await writeFile(join(worktreePath, 'g.txt'), 'g\n');
      await execGit(['add', 'g.txt']);
      await execGit(['commit', '-q', '-m', 'add g']);
      const featureSha = await execGit(['rev-parse', 'feature']);
      await execGit(['checkout', '-q', 'main']);

      const result = await mergeBranch(target, worktreePath, { name: 'feature' });
      expect(result.fastForward).toBe(true);
      await expect(execGit(['rev-parse', 'HEAD'])).resolves.toBe(featureSha);
    });

    it('creates a real merge commit for diverged histories — HEAD gets a second parent', async () => {
      await execGit(['checkout', '-q', '-b', 'feature']);
      await writeFile(join(worktreePath, 'g.txt'), 'g\n');
      await execGit(['add', 'g.txt']);
      await execGit(['commit', '-q', '-m', 'add g']);
      await execGit(['checkout', '-q', 'main']);
      await writeFile(join(worktreePath, 'h.txt'), 'h\n');
      await execGit(['add', 'h.txt']);
      await execGit(['commit', '-q', '-m', 'add h']);

      const result = await mergeBranch(target, worktreePath, { name: 'feature' });
      expect(result.fastForward).toBe(false);
      const parents = await execGit(['log', '-1', '--pretty=%P']);
      expect(parents.split(' ')).toHaveLength(2);
    });

    it('throws GitMergeConflictError with the real conflicted path, leaving the worktree genuinely mid-merge for the client to render', async () => {
      await execGit(['checkout', '-q', '-b', 'feature']);
      await writeFile(join(worktreePath, 'f.txt'), 'feature-change\n');
      await execGit(['commit', '-q', '-am', 'feature change']);
      await execGit(['checkout', '-q', 'main']);
      await writeFile(join(worktreePath, 'f.txt'), 'main-change\n');
      await execGit(['commit', '-q', '-am', 'main change']);

      let caught: unknown;
      try {
        await mergeBranch(target, worktreePath, { name: 'feature' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitMergeConflictError);
      expect((caught as InstanceType<typeof GitMergeConflictError>).conflictedPaths).toEqual([
        'f.txt',
      ]);
      // Genuinely mid-merge on disk — MERGE_HEAD exists, `git status` sees
      // it too — never a swallowed failure that leaves no trace.
      await expect(
        execFileAsync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: worktreePath }),
      ).resolves.toBeTruthy();
    });

    it('throws GitBranchNotFoundError for a name matching no branch', async () => {
      await expect(mergeBranch(target, worktreePath, { name: 'no-such-branch' })).rejects.toThrow(
        GitBranchNotFoundError,
      );
    });
  });

  describe('abortMerge', () => {
    it('cleanly resolves a real conflicted merge back to the pre-merge state — the "abort" half of resolve-or-abort', async () => {
      await execGit(['checkout', '-q', '-b', 'feature']);
      await writeFile(join(worktreePath, 'f.txt'), 'feature-change\n');
      await execGit(['commit', '-q', '-am', 'feature change']);
      await execGit(['checkout', '-q', 'main']);
      await writeFile(join(worktreePath, 'f.txt'), 'main-change\n');
      await execGit(['commit', '-q', '-am', 'main change']);
      await expect(mergeBranch(target, worktreePath, { name: 'feature' })).rejects.toThrow(
        GitMergeConflictError,
      );

      await abortMerge(target, worktreePath);

      await expect(readFile(join(worktreePath, 'f.txt'), 'utf8')).resolves.toBe('main-change\n');
      const status = await execGit(['status', '--porcelain']);
      expect(status).toBe('');
      await expect(
        execFileAsync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: worktreePath }),
      ).rejects.toThrow();
    });

    it('throws GitBranchActionError when there is no merge in progress to abort', async () => {
      await expect(abortMerge(target, worktreePath)).rejects.toThrow(GitBranchActionError);
    });
  });
});

describe('stash save/list/pop/drop against a real local git repo (issue #234)', () => {
  let worktreePath: string;
  const target: ExecutionTarget = new LocalExecutionTarget();

  async function execGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: worktreePath });
    return stdout.trim();
  }

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'loombox-git-stash-'));
    await execGit(['init', '-q', '-b', 'main']);
    await execGit(['config', 'user.email', 'test@loombox.dev']);
    await execGit(['config', 'user.name', 'loombox test']);
    await writeFile(join(worktreePath, 'f.txt'), 'base\n');
    await execGit(['add', 'f.txt']);
    await execGit(['commit', '-q', '-m', 'base']);
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  describe('stashSave / listStashes', () => {
    it('reports created: false and leaves the stash stack empty when there is nothing to stash', async () => {
      const result = await stashSave(target, worktreePath, { message: null });
      expect(result.created).toBe(false);
      await expect(listStashes(target, worktreePath)).resolves.toEqual([]);
    });

    it('stashes a tracked modification AND an untracked file (git stash push -u), clearing the real worktree back to HEAD', async () => {
      await writeFile(join(worktreePath, 'f.txt'), 'dirty\n');
      await writeFile(join(worktreePath, 'untracked.txt'), 'new\n');

      const result = await stashSave(target, worktreePath, { message: 'my changes' });
      expect(result.created).toBe(true);

      await expect(readFile(join(worktreePath, 'f.txt'), 'utf8')).resolves.toBe('base\n');
      await expect(access(join(worktreePath, 'untracked.txt'))).rejects.toThrow();

      const stashes = await listStashes(target, worktreePath);
      expect(stashes).toHaveLength(1);
      expect(stashes[0]?.index).toBe(0);
      expect(stashes[0]?.message).toContain('my changes');
    });

    it('stacks multiple stashes, most recent at index 0', async () => {
      await writeFile(join(worktreePath, 'f.txt'), 'first-change\n');
      await stashSave(target, worktreePath, { message: 'first' });
      await writeFile(join(worktreePath, 'f.txt'), 'second-change\n');
      await stashSave(target, worktreePath, { message: 'second' });

      const stashes = await listStashes(target, worktreePath);
      expect(stashes.map((s) => s.message).join('|')).toMatch(/second.*\|.*first/);
    });
  });

  describe('stashPop', () => {
    it('restores the real stashed content and drops the entry off the stack', async () => {
      await writeFile(join(worktreePath, 'f.txt'), 'dirty\n');
      await stashSave(target, worktreePath, { message: null });

      await stashPop(target, worktreePath, { index: null });

      await expect(readFile(join(worktreePath, 'f.txt'), 'utf8')).resolves.toBe('dirty\n');
      await expect(listStashes(target, worktreePath)).resolves.toEqual([]);
    });

    it('throws GitStashNotFoundError for an empty stash stack', async () => {
      await expect(stashPop(target, worktreePath, { index: null })).rejects.toThrow(
        GitStashNotFoundError,
      );
    });

    it('throws GitStashPopConflictError with the real conflicted path when the pop cannot complete cleanly, and KEEPS the stash entry — nothing is lost', async () => {
      await writeFile(join(worktreePath, 'f.txt'), 'stashed-version\n');
      await stashSave(target, worktreePath, { message: 'conflicting stash' });
      await writeFile(join(worktreePath, 'f.txt'), 'committed-version\n');
      await execGit(['commit', '-q', '-am', 'diverging commit']);

      let caught: unknown;
      try {
        await stashPop(target, worktreePath, { index: null });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitStashPopConflictError);
      expect((caught as InstanceType<typeof GitStashPopConflictError>).conflictedPaths).toEqual([
        'f.txt',
      ]);
      // The stash is genuinely still there — a failed pop never loses it.
      const stashes = await listStashes(target, worktreePath);
      expect(stashes).toHaveLength(1);
    });
  });

  describe('stashDrop', () => {
    it('removes the real stash entry off the stack for good', async () => {
      await writeFile(join(worktreePath, 'f.txt'), 'dirty\n');
      await stashSave(target, worktreePath, { message: null });

      await stashDrop(target, worktreePath, { index: 0 });

      await expect(listStashes(target, worktreePath)).resolves.toEqual([]);
    });

    it('throws GitStashNotFoundError for an index naming no real entry', async () => {
      await expect(stashDrop(target, worktreePath, { index: 0 })).rejects.toThrow(
        GitStashNotFoundError,
      );
    });
  });
});

describe('pushBranch against a real local git repo with a real bare remote (issue #235)', () => {
  let bareDir: string;
  let worktreePath: string;
  let peerDir: string | undefined;
  const target: ExecutionTarget = new LocalExecutionTarget();

  async function execGit(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  }

  beforeEach(async () => {
    bareDir = await mkdtemp(join(tmpdir(), 'loombox-git-push-remote-'));
    await execFileAsync('git', ['init', '--bare', '-q', '-b', 'main', bareDir]);

    worktreePath = await mkdtemp(join(tmpdir(), 'loombox-git-push-work-'));
    await execFileAsync('git', ['clone', '-q', bareDir, worktreePath]);
    await execGit(worktreePath, ['config', 'user.email', 'test@loombox.dev']);
    await execGit(worktreePath, ['config', 'user.name', 'loombox test']);
    await execGit(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'initial']);
    await execGit(worktreePath, ['push', '-q', 'origin', 'main']);
    await execGit(worktreePath, ['checkout', '-q', '-b', 'feature']);
  });

  afterEach(async () => {
    await rm(bareDir, { recursive: true, force: true });
    await rm(worktreePath, { recursive: true, force: true });
    if (peerDir) {
      await rm(peerDir, { recursive: true, force: true });
      peerDir = undefined;
    }
  });

  /** Clones `bareDir` into a fresh dir, checks out `feature` (already pushed by the caller), and commits `subject` on it — a second, real contributor working from a different checkout, entirely independent of `pushBranch`/`worktreePath`. */
  async function peerCommitsAndPushes(subject: string): Promise<void> {
    peerDir = await mkdtemp(join(tmpdir(), 'loombox-git-push-peer-'));
    await execFileAsync('git', ['clone', '-q', bareDir, peerDir]);
    await execGit(peerDir, ['config', 'user.email', 'peer@loombox.dev']);
    await execGit(peerDir, ['config', 'user.name', 'loombox peer']);
    await execGit(peerDir, ['checkout', '-q', 'feature']);
    await execGit(peerDir, ['commit', '-q', '--allow-empty', '-m', subject]);
    await execGit(peerDir, ['push', '-q', 'origin', 'feature']);
  }

  it("a clean push sets upstream tracking on this branch's first push, and lands the real commit on the bare remote", async () => {
    await execGit(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'feature work']);

    const result = await pushBranch(target, worktreePath, 'feature');

    expect(result).toEqual({ setUpstream: true, forced: false });
    const remoteRefs = await execFileAsync('git', ['ls-remote', '--heads', bareDir]);
    expect(remoteRefs.stdout).toContain('refs/heads/feature');
    await expect(execGit(worktreePath, ['rev-parse', '--abbrev-ref', 'feature@{u}'])).resolves.toBe(
      'origin/feature',
    );
  });

  it('a second push on an already-tracked branch reports setUpstream: false — upstream is set exactly once', async () => {
    await execGit(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'feature work 1']);
    await pushBranch(target, worktreePath, 'feature');
    await execGit(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'feature work 2']);

    const result = await pushBranch(target, worktreePath, 'feature');

    expect(result).toEqual({ setUpstream: false, forced: false });
  });

  it('rejected_non_fast_forward: honestly reported, never silently swallowed, when the remote has commits this branch does not', async () => {
    await execGit(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'feature work']);
    await pushBranch(target, worktreePath, 'feature');
    await peerCommitsAndPushes('peer work');
    // worktreePath never fetched the peer's commit — its own new commit
    // diverges from what the remote now has, so a fast-forward push is
    // impossible.
    await execGit(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'diverging local work']);

    const error = await pushBranch(target, worktreePath, 'feature').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitPushNonFastForwardError);
    // The rejected push never silently landed anything — the remote
    // still only has the peer's commit.
    const remoteLog = await execFileAsync('git', ['log', '-1', '--format=%s', 'feature'], {
      cwd: bareDir,
    });
    expect(remoteLog.stdout.trim()).toBe('peer work');
  });

  it('force: true (--force-with-lease) refuses a stale lease, then succeeds once this worktree refreshes its knowledge of the remote', async () => {
    await execGit(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'feature work']);
    await pushBranch(target, worktreePath, 'feature');
    await peerCommitsAndPushes('peer work');
    await execGit(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'diverging local work']);

    // Force-with-lease WITHOUT fetching first: this worktree's own
    // knowledge of origin/feature still points at its pre-peer commit,
    // so the lease is stale — exactly what --force-with-lease (never
    // plain --force) exists to refuse, rather than blindly discarding
    // the peer's commit it never even saw.
    const staleError = await pushBranch(target, worktreePath, 'feature', { force: true }).catch(
      (e: unknown) => e,
    );
    expect(staleError).toBeInstanceOf(GitPushStaleLeaseError);
    const stillPeerLog = await execFileAsync('git', ['log', '-1', '--format=%s', 'feature'], {
      cwd: bareDir,
    });
    expect(stillPeerLog.stdout.trim()).toBe('peer work');

    // Fetching re-syncs the lease — force-with-lease now knows exactly
    // what it is overwriting, and succeeds.
    await execGit(worktreePath, ['fetch', '-q', 'origin']);
    const result = await pushBranch(target, worktreePath, 'feature', { force: true });
    expect(result).toEqual({ setUpstream: false, forced: true });
    const finalLog = await execFileAsync('git', ['log', '-1', '--format=%s', 'feature'], {
      cwd: bareDir,
    });
    expect(finalLog.stdout.trim()).toBe('diverging local work');
  });

  it('auth_failed: a remote that refuses the credentials themselves is reported distinctly, never as a generic failure — hermetic, no real network', async () => {
    await execGit(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'feature work']);
    await execGit(worktreePath, [
      'remote',
      'set-url',
      'origin',
      'ssh://git@auth-failure.invalid.example/repo.git',
    ]);
    // `GIT_SSH_COMMAND` fully replaces the `ssh` invocation git would
    // otherwise make — this script runs instead, so no DNS lookup or
    // real network connection is ever attempted.
    const fakeSshCommand = 'sh -c \'echo "Permission denied (publickey)." >&2; exit 255\'';
    const hermeticTarget: ExecutionTarget = {
      kind: 'local',
      exec: (command, args, options = {}) =>
        target.exec(command, args, {
          ...options,
          env: { ...options.env, GIT_SSH_COMMAND: fakeSshCommand },
        }),
      readFile: (p) => target.readFile(p),
      writeFile: (p, content) => target.writeFile(p, content),
      mkdir: (p) => target.mkdir(p),
      readdir: (p) => target.readdir(p),
      readdirDetailed: (p) => target.readdirDetailed(p),
    };

    const error = await pushBranch(hermeticTarget, worktreePath, 'feature').catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(GitPushAuthenticationError);
    expect((error as Error).message).toContain('Permission denied');
  });

  it('error: any other push failure (e.g. no configured remote) is still reported, not swallowed', async () => {
    await execGit(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'feature work']);
    await execGit(worktreePath, ['remote', 'remove', 'origin']);

    const error = await pushBranch(target, worktreePath, 'feature').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitBranchActionError);
    expect(error).not.toBeInstanceOf(GitPushNonFastForwardError);
    expect(error).not.toBeInstanceOf(GitPushStaleLeaseError);
    expect(error).not.toBeInstanceOf(GitPushAuthenticationError);
  });
});
