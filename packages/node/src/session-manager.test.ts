import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from './session-manager';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('SessionManager', () => {
  let repoPath: string;
  let manager: SessionManager;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'loombox-repo-'));
    tempDirs.push(repoPath);
    await git(repoPath, ['init', '-b', 'main']);
    await git(repoPath, ['config', 'user.email', 'test@loombox.dev']);
    await git(repoPath, ['config', 'user.name', 'loombox test']);
    await execFileAsync(
      'git',
      ['-C', repoPath, 'commit', '--allow-empty', '-m', 'initial commit'],
      {
        cwd: repoPath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'loombox test',
          GIT_AUTHOR_EMAIL: 'test@loombox.dev',
          GIT_COMMITTER_NAME: 'loombox test',
          GIT_COMMITTER_EMAIL: 'test@loombox.dev',
        },
      },
    );

    manager = new SessionManager();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('creates a session with a fresh git worktree on a new branch', async () => {
    const session = await manager.createSession({ projectPath: repoPath, provider: 'claude' });

    expect(session.projectPath).toBe(repoPath);
    expect(session.provider).toBe('claude');
    expect(session.target).toBe('local');
    expect(session.branch).toBe(`loombox/session-${session.id}`);
    expect(session.worktreePath.startsWith(repoPath)).toBe(true);
    expect(typeof session.createdAt).toBe('number');

    const dirStat = await stat(session.worktreePath);
    expect(dirStat.isDirectory()).toBe(true);

    // The worktree is a real git worktree: `git rev-parse --is-inside-work-tree`
    // succeeds and the current branch matches the recorded session branch.
    const insideWorkTree = await git(session.worktreePath, ['rev-parse', '--is-inside-work-tree']);
    expect(insideWorkTree).toBe('true');

    const currentBranch = await git(session.worktreePath, ['branch', '--show-current']);
    expect(currentBranch).toBe(session.branch);

    const worktreeList = await git(repoPath, ['worktree', 'list', '--porcelain']);
    expect(worktreeList).toContain(session.worktreePath);
  });

  it('stores and retrieves sessions via getSession and listSessions', async () => {
    const first = await manager.createSession({ projectPath: repoPath, provider: 'claude' });
    const second = await manager.createSession({ projectPath: repoPath, provider: 'codex' });

    expect(manager.getSession(first.id)).toEqual(first);
    expect(manager.getSession(second.id)).toEqual(second);
    expect(manager.getSession('does-not-exist')).toBeUndefined();

    const listed = manager.listSessions();
    expect(listed).toHaveLength(2);
    expect(listed.map((s) => s.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('rejects createSession when projectPath is not a git repo', async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), 'loombox-nongit-'));
    tempDirs.push(nonGitDir);

    await expect(
      manager.createSession({ projectPath: nonGitDir, provider: 'claude' }),
    ).rejects.toThrow(/not a git repository/i);

    expect(manager.listSessions()).toHaveLength(0);
  });

  it('rejects createSession when projectPath does not exist', async () => {
    const missingDir = join(repoPath, 'does-not-exist');

    await expect(
      manager.createSession({ projectPath: missingDir, provider: 'claude' }),
    ).rejects.toThrow();
  });

  it('removes a session and its worktree directory', async () => {
    const session = await manager.createSession({ projectPath: repoPath, provider: 'claude' });

    await manager.removeSession(session.id);

    expect(manager.getSession(session.id)).toBeUndefined();
    expect(manager.listSessions()).toHaveLength(0);

    await expect(stat(session.worktreePath)).rejects.toThrow();

    const worktreeList = await git(repoPath, ['worktree', 'list', '--porcelain']);
    expect(worktreeList).not.toContain(session.worktreePath);
  });

  it('rejects removeSession for an unknown id', async () => {
    await expect(manager.removeSession('unknown-id')).rejects.toThrow(/no session/i);
  });
});
