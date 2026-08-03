import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CheckpointNotFoundError,
  DetachedHeadError,
  DirtySubmoduleError,
  GitCheckpointStore,
  NotAGitWorktreeError,
} from './git-checkpoint-store';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** Every temp dir any test in this file created — removed in `afterEach`, per the "every temp repo the tests create is removed afterwards" acceptance criterion. */
const tempDirs: string[] = [];

/** A real temporary git repo with one commit on `main` — checkpoint/rollback is a git-mechanics feature, so every test here exercises a real repo, never a mocked one. */
async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'loombox-checkpoint-repo-'));
  tempDirs.push(repoPath);
  await git(repoPath, ['init', '-q', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'test@loombox.dev']);
  await git(repoPath, ['config', 'user.name', 'loombox test']);
  await writeFile(join(repoPath, 'tracked.txt'), 'tracked v1\n');
  await git(repoPath, ['add', 'tracked.txt']);
  await git(repoPath, ['commit', '-q', '-m', 'init']);
  return repoPath;
}

/** A session-shaped worktree off `repoPath`, on its own branch — the same layout `SessionManager`/`./ssh/remote-worktree.ts` create for a real session. */
async function createSessionWorktree(repoPath: string, sessionId: string): Promise<string> {
  const worktreePath = join(repoPath, '.loombox', 'worktrees', sessionId);
  await git(repoPath, [
    'worktree',
    'add',
    '-q',
    '-b',
    `loombox/session-${sessionId}`,
    worktreePath,
    'HEAD',
  ]);
  tempDirs.push(worktreePath);
  return worktreePath;
}

async function statusPorcelain(worktreePath: string): Promise<string> {
  return git(worktreePath, ['status', '--porcelain=v2', '--ignore-submodules=none']);
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

describe('GitCheckpointStore', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('captures staged, unstaged, and new untracked source files with no commit required', async () => {
    const repoPath = await createRepo();
    const worktreePath = await createSessionWorktree(repoPath, 'sess-capture');
    const store = new GitCheckpointStore({ worktreePath, sessionId: 'sess-capture' });

    await writeFile(join(worktreePath, 'staged.txt'), 'staged content\n');
    await git(worktreePath, ['add', 'staged.txt']);
    await writeFile(join(worktreePath, 'tracked.txt'), 'tracked v1\nunstaged edit\n');
    await writeFile(join(worktreePath, 'new_src.js'), 'export const x = 1;\n');

    const beforeStatus = await statusPorcelain(worktreePath);
    expect(beforeStatus).toContain('staged.txt');
    expect(beforeStatus).toContain('tracked.txt');

    const checkpoint = await store.checkpoint({ message: 'mid-session' });

    expect(checkpoint.sessionId).toBe('sess-capture');
    expect(checkpoint.message).toBe('mid-session');
    expect(checkpoint.hasStagedChanges).toBe(true);
    expect(checkpoint.hasUnstagedChanges).toBe(true);
    expect(checkpoint.hasUntrackedFiles).toBe(true);

    // Taking a checkpoint never commits anything and never touches the
    // worktree's own uncommitted state.
    expect(await git(worktreePath, ['rev-parse', 'HEAD'])).toBe(checkpoint.baseCommit);
    expect(await statusPorcelain(worktreePath)).toBe(beforeStatus);
  });

  it('.gitignored paths are not captured', async () => {
    const repoPath = await createRepo();
    const worktreePath = await createSessionWorktree(repoPath, 'sess-ignore');
    const store = new GitCheckpointStore({ worktreePath, sessionId: 'sess-ignore' });

    await writeFile(join(worktreePath, '.gitignore'), 'node_modules/\n*.log\n');
    await git(worktreePath, ['add', '.gitignore']);
    await git(worktreePath, ['commit', '-q', '-m', 'add gitignore']);

    await mkdir(join(worktreePath, 'node_modules'), { recursive: true });
    await writeFile(join(worktreePath, 'node_modules', 'x.js'), 'junk\n');
    await writeFile(join(worktreePath, 'debug.log'), 'noise\n');
    await writeFile(join(worktreePath, 'real_source.ts'), 'export const y = 2;\n');

    const checkpoint = await store.checkpoint();

    // Delete every untracked file, then restore: only the non-ignored one
    // should come back.
    await rm(join(worktreePath, 'node_modules'), { recursive: true, force: true });
    await rm(join(worktreePath, 'debug.log'), { force: true });
    await rm(join(worktreePath, 'real_source.ts'), { force: true });

    await store.restore(checkpoint.id);

    expect(await exists(join(worktreePath, 'real_source.ts'))).toBe(true);
    expect(await exists(join(worktreePath, 'node_modules', 'x.js'))).toBe(false);
    expect(await exists(join(worktreePath, 'debug.log'))).toBe(false);
  });

  it('restores exact state including the staged/unstaged split, and removes files created after the checkpoint, when the agent never committed since', async () => {
    const repoPath = await createRepo();
    const worktreePath = await createSessionWorktree(repoPath, 'sess-restore');
    const store = new GitCheckpointStore({ worktreePath, sessionId: 'sess-restore' });

    await writeFile(join(worktreePath, 'staged.txt'), 'staged content\n');
    await git(worktreePath, ['add', 'staged.txt']);
    await writeFile(join(worktreePath, 'tracked.txt'), 'tracked v1\nunstaged edit\n');
    await writeFile(join(worktreePath, 'new_src.js'), 'export const x = 1;\n');

    const checkpoint = await store.checkpoint();
    const statusAtCheckpoint = await statusPorcelain(worktreePath);

    // Mutate everything after the checkpoint: more edits, a new staged
    // file, a new untracked file, delete the checkpoint's untracked file.
    await writeFile(join(worktreePath, 'tracked.txt'), 'tracked v1\nunstaged edit\nmore edits\n');
    await writeFile(join(worktreePath, 'staged2.txt'), 'another staged file\n');
    await git(worktreePath, ['add', 'staged2.txt']);
    await writeFile(join(worktreePath, 'post_checkpoint.js'), 'created after checkpoint\n');
    await rm(join(worktreePath, 'new_src.js'), { force: true });

    const result = await store.restore(checkpoint.id);

    expect(result.discardedUncommittedChanges).toBe(true);
    expect(result.commitsPreserved).toBe(0);

    expect(await readFile(join(worktreePath, 'tracked.txt'), 'utf8')).toBe(
      'tracked v1\nunstaged edit\n',
    );
    expect(await readFile(join(worktreePath, 'staged.txt'), 'utf8')).toBe('staged content\n');
    expect(await readFile(join(worktreePath, 'new_src.js'), 'utf8')).toBe('export const x = 1;\n');
    expect(await exists(join(worktreePath, 'staged2.txt'))).toBe(false);
    expect(await exists(join(worktreePath, 'post_checkpoint.js'))).toBe(false);

    // The staged/unstaged split itself, not just file contents, is back:
    // `tracked.txt` shows as an unstaged modification, `staged.txt` as a
    // staged addition — exactly as it was the moment the checkpoint was
    // taken.
    expect(await statusPorcelain(worktreePath)).toBe(statusAtCheckpoint);
  });

  it('handles a commit the agent made after the checkpoint by reverting its working-tree effect without ever moving HEAD or dropping the commit', async () => {
    const repoPath = await createRepo();
    const worktreePath = await createSessionWorktree(repoPath, 'sess-commit');
    const store = new GitCheckpointStore({ worktreePath, sessionId: 'sess-commit' });

    await writeFile(join(worktreePath, 'staged.txt'), 'v1 staged\n');
    await git(worktreePath, ['add', 'staged.txt']);
    const checkpoint = await store.checkpoint();
    const preCommitHead = checkpoint.baseCommit;

    // The agent commits the staged file for real, then keeps editing
    // unstaged on top of that commit.
    await git(worktreePath, ['commit', '-q', '-m', 'agent commit after checkpoint']);
    const postCommitHead = await git(worktreePath, ['rev-parse', 'HEAD']);
    expect(postCommitHead).not.toBe(preCommitHead);
    await writeFile(join(worktreePath, 'staged.txt'), 'v1 staged\nmore uncommitted edits\n');

    const preview = await store.previewRestore(checkpoint.id);
    expect(preview.commitsSinceCheckpoint).toBe(1);
    expect(preview.hasUncommittedChangesToDiscard).toBe(true);

    const result = await store.restore(checkpoint.id);

    // The rule: restore never rewrites, resets, or moves HEAD/branch refs —
    // the agent's real commit is preserved in full, still on HEAD, still in
    // `git log`. Only the *uncommitted* edit made after the checkpoint is
    // discarded, and the working tree's file content matches the
    // checkpoint exactly regardless of what got committed since.
    expect(result.commitsPreserved).toBe(1);
    expect(await git(worktreePath, ['rev-parse', 'HEAD'])).toBe(postCommitHead);
    const log = await git(worktreePath, ['log', '--format=%s']);
    expect(log).toContain('agent commit after checkpoint');
    expect(await readFile(join(worktreePath, 'staged.txt'), 'utf8')).toBe('v1 staged\n');
  });

  it('lists checkpoints for a session, oldest first, and can delete one or all of them', async () => {
    const repoPath = await createRepo();
    const worktreePath = await createSessionWorktree(repoPath, 'sess-list');
    const store = new GitCheckpointStore({ worktreePath, sessionId: 'sess-list' });

    const first = await store.checkpoint({ message: 'first' });
    await writeFile(join(worktreePath, 'tracked.txt'), 'tracked v1\nedit\n');
    const second = await store.checkpoint({ message: 'second' });

    const listed = await store.listCheckpoints();
    expect(listed.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(listed.map((c) => c.message)).toEqual(['first', 'second']);

    await store.deleteCheckpoint(first.id);
    expect((await store.listCheckpoints()).map((c) => c.id)).toEqual([second.id]);
    await expect(store.deleteCheckpoint(first.id)).rejects.toThrow(CheckpointNotFoundError);

    await store.deleteAllCheckpoints();
    expect(await store.listCheckpoints()).toEqual([]);
  });

  it('never leaks checkpoints across sessions sharing the same repo', async () => {
    const repoPath = await createRepo();
    const worktreeA = await createSessionWorktree(repoPath, 'sess-a');
    const worktreeB = await createSessionWorktree(repoPath, 'sess-b');
    const storeA = new GitCheckpointStore({ worktreePath: worktreeA, sessionId: 'sess-a' });
    const storeB = new GitCheckpointStore({ worktreePath: worktreeB, sessionId: 'sess-b' });

    await storeA.checkpoint({ message: 'from A' });

    expect(await storeB.listCheckpoints()).toEqual([]);
    expect((await storeA.listCheckpoints())[0]?.message).toBe('from A');
  });

  it('throws CheckpointNotFoundError for an unknown checkpoint id', async () => {
    const repoPath = await createRepo();
    const worktreePath = await createSessionWorktree(repoPath, 'sess-missing');
    const store = new GitCheckpointStore({ worktreePath, sessionId: 'sess-missing' });

    await expect(store.restore('does-not-exist')).rejects.toThrow(CheckpointNotFoundError);
    await expect(store.previewRestore('does-not-exist')).rejects.toThrow(CheckpointNotFoundError);
  });

  it('fails cleanly with a named error when worktreePath is not a git repository', async () => {
    const plainDir = await mkdtemp(join(tmpdir(), 'loombox-checkpoint-notgit-'));
    tempDirs.push(plainDir);
    await writeFile(join(plainDir, 'file.txt'), 'not a repo\n');
    const store = new GitCheckpointStore({ worktreePath: plainDir, sessionId: 'sess-notgit' });

    await expect(store.checkpoint()).rejects.toThrow(NotAGitWorktreeError);
    // Nothing was touched.
    expect(await readFile(join(plainDir, 'file.txt'), 'utf8')).toBe('not a repo\n');
  });

  it('fails cleanly with a named error on a detached HEAD, without corrupting anything', async () => {
    const repoPath = await createRepo();
    const worktreePath = await createSessionWorktree(repoPath, 'sess-detached');
    const head = await git(worktreePath, ['rev-parse', 'HEAD']);
    await git(worktreePath, ['checkout', '-q', '--detach', head]);
    const store = new GitCheckpointStore({ worktreePath, sessionId: 'sess-detached' });

    await expect(store.checkpoint()).rejects.toThrow(DetachedHeadError);
    expect(await store.listCheckpoints()).toEqual([]);
    expect(await git(worktreePath, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('fails cleanly with a named error on a dirty submodule, without corrupting anything', async () => {
    const subRepoPath = await createRepo();
    const repoPath = await createRepo();
    await execFileAsync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', subRepoPath, 'sub'],
      { cwd: repoPath },
    );
    await git(repoPath, ['commit', '-q', '-m', 'add submodule']);
    const worktreePath = await createSessionWorktree(repoPath, 'sess-submodule');
    // `git worktree add` never auto-populates submodules (verified against
    // real git 2.47) — each worktree initializes its own checkout of them.
    await execFileAsync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'],
      { cwd: worktreePath },
    );

    // Dirty the submodule's own working tree (uncommitted content inside
    // it) without changing what the superproject has staged for it.
    await writeFile(join(worktreePath, 'sub', 'tracked.txt'), 'dirtied from outside\n');

    const store = new GitCheckpointStore({ worktreePath, sessionId: 'sess-submodule' });
    const headBefore = await git(worktreePath, ['rev-parse', 'HEAD']);

    await expect(store.checkpoint()).rejects.toThrow(DirtySubmoduleError);
    expect(await store.listCheckpoints()).toEqual([]);
    expect(await git(worktreePath, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await readFile(join(worktreePath, 'sub', 'tracked.txt'), 'utf8')).toBe(
      'dirtied from outside\n',
    );
  });
});
