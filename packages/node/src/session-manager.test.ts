import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidSessionTransitionError, SessionManager } from './session-manager';

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

  describe('workInPlace (issue #75)', () => {
    it('runs directly in projectPath instead of creating a worktree', async () => {
      const session = await manager.createSession({
        projectPath: repoPath,
        provider: 'claude',
        workInPlace: true,
      });

      expect(session.worktreePath).toBe(repoPath);
      expect(session.branch).toBe('');

      const worktreeList = await git(repoPath, ['worktree', 'list', '--porcelain']);
      // Only the repo's own primary worktree entry exists — no session
      // worktree was added.
      expect(worktreeList.split('\n\n').filter((entry) => entry.trim())).toHaveLength(1);
    });

    it('removeSession on a workInPlace session forgets the record without touching projectPath', async () => {
      const session = await manager.createSession({
        projectPath: repoPath,
        provider: 'claude',
        workInPlace: true,
      });

      await manager.removeSession(session.id);

      expect(manager.getSession(session.id)).toBeUndefined();
      // projectPath itself must still exist and still be the git repo it was.
      const dirStat = await stat(repoPath);
      expect(dirStat.isDirectory()).toBe(true);
      const insideWorkTree = await git(repoPath, ['rev-parse', '--is-inside-work-tree']);
      expect(insideWorkTree).toBe('true');
    });

    it('defaults to creating an isolated worktree when workInPlace is omitted', async () => {
      const session = await manager.createSession({ projectPath: repoPath, provider: 'claude' });
      expect(session.worktreePath).not.toBe(repoPath);
      expect(session.branch).not.toBe('');
    });
  });

  describe('same-folder safety (issue #68, SPEC §7.2)', () => {
    it('refuses a second in-place session on a folder that already has one running', async () => {
      const first = await manager.createSession({
        projectPath: repoPath,
        provider: 'claude',
        workInPlace: true,
      });
      expect(first.state).toBe('running');

      await expect(
        manager.createSession({ projectPath: repoPath, provider: 'claude', workInPlace: true }),
      ).rejects.toThrow(/already running/i);

      // The refused attempt never touched anything: still exactly one
      // session on this project.
      expect(manager.listSessions()).toHaveLength(1);
    });

    it('two sessions on the same project using separate worktrees are unaffected', async () => {
      const a = await manager.createSession({ projectPath: repoPath, provider: 'claude' });
      const b = await manager.createSession({ projectPath: repoPath, provider: 'claude' });

      expect(a.worktreePath).not.toBe(b.worktreePath);
      expect(manager.listSessions()).toHaveLength(2);
    });

    it('a worktree session does not block, and is not blocked by, an in-place session on the same project', async () => {
      const inPlace = await manager.createSession({
        projectPath: repoPath,
        provider: 'claude',
        workInPlace: true,
      });
      const worktreed = await manager.createSession({ projectPath: repoPath, provider: 'claude' });

      expect(inPlace.worktreePath).toBe(repoPath);
      expect(worktreed.worktreePath).not.toBe(repoPath);
      expect(manager.listSessions()).toHaveLength(2);
    });

    it('a new in-place session is allowed once the first one ends', async () => {
      const first = await manager.createSession({
        projectPath: repoPath,
        provider: 'claude',
        workInPlace: true,
      });
      manager.endSession(first.id);

      const second = await manager.createSession({
        projectPath: repoPath,
        provider: 'claude',
        workInPlace: true,
      });
      expect(second.id).not.toBe(first.id);
      expect(second.worktreePath).toBe(repoPath);
    });

    it('a new in-place session is allowed once the first one is force-removed while still running', async () => {
      const first = await manager.createSession({
        projectPath: repoPath,
        provider: 'claude',
        workInPlace: true,
      });
      await manager.removeSession(first.id);

      await expect(
        manager.createSession({ projectPath: repoPath, provider: 'claude', workInPlace: true }),
      ).resolves.toMatchObject({ worktreePath: repoPath });
    });

    it('in-place sessions on different projects never contend', async () => {
      const otherRepoPath = await mkdtemp(join(tmpdir(), 'loombox-repo-other-'));
      tempDirs.push(otherRepoPath);
      await git(otherRepoPath, ['init', '-b', 'main']);
      await git(otherRepoPath, ['config', 'user.email', 'test@loombox.dev']);
      await git(otherRepoPath, ['config', 'user.name', 'loombox test']);
      await execFileAsync('git', ['-C', otherRepoPath, 'commit', '--allow-empty', '-m', 'init'], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'loombox test',
          GIT_AUTHOR_EMAIL: 'test@loombox.dev',
          GIT_COMMITTER_NAME: 'loombox test',
          GIT_COMMITTER_EMAIL: 'test@loombox.dev',
        },
      });

      await expect(
        manager.createSession({ projectPath: repoPath, provider: 'claude', workInPlace: true }),
      ).resolves.toBeDefined();
      await expect(
        manager.createSession({
          projectPath: otherRepoPath,
          provider: 'claude',
          workInPlace: true,
        }),
      ).resolves.toBeDefined();
    });
  });

  it('uses a caller-supplied id instead of generating one, when given', async () => {
    const session = await manager.createSession({
      projectPath: repoPath,
      provider: 'claude',
      id: 'explicit-session-id',
    });

    expect(session.id).toBe('explicit-session-id');
    expect(session.branch).toBe('loombox/session-explicit-session-id');
    expect(manager.getSession('explicit-session-id')).toEqual(session);
  });

  it('records the owning node id and target id, and defaults targetId to "local"', async () => {
    const withNode = await manager.createSession({
      projectPath: repoPath,
      provider: 'claude',
      nodeId: 'node-1',
    });
    expect(withNode.nodeId).toBe('node-1');
    expect(withNode.targetId).toBe('local');

    const withTarget = await manager.createSession({
      projectPath: repoPath,
      provider: 'claude',
      nodeId: 'node-1',
      targetId: 'devbox',
    });
    expect(withTarget.targetId).toBe('devbox');

    const bare = await manager.createSession({ projectPath: repoPath, provider: 'claude' });
    expect(bare.nodeId).toBeUndefined();
    expect(bare.targetId).toBe('local');
  });

  describe('lifecycle', () => {
    it('starts a fresh session in the "running" state', async () => {
      const session = await manager.createSession({ projectPath: repoPath, provider: 'claude' });
      expect(session.state).toBe('running');
    });

    it('accepts the valid running -> paused -> running -> ended transitions', async () => {
      const session = await manager.createSession({ projectPath: repoPath, provider: 'claude' });

      const paused = manager.pauseSession(session.id);
      expect(paused.state).toBe('paused');
      expect(paused).toBe(session); // mutated in place, same record

      const resumed = manager.resumeSession(session.id);
      expect(resumed.state).toBe('running');

      const ended = manager.endSession(session.id);
      expect(ended.state).toBe('ended');
    });

    it('also allows ending directly from "running" (no pause required)', async () => {
      const session = await manager.createSession({ projectPath: repoPath, provider: 'claude' });
      const ended = manager.endSession(session.id);
      expect(ended.state).toBe('ended');
    });

    it('rejects pausing a session that is already paused', async () => {
      const session = await manager.createSession({ projectPath: repoPath, provider: 'claude' });
      manager.pauseSession(session.id);

      expect(() => manager.pauseSession(session.id)).toThrow(InvalidSessionTransitionError);
      expect(session.state).toBe('paused'); // unchanged by the rejected attempt
    });

    it('rejects resuming a session that was never paused', async () => {
      const session = await manager.createSession({ projectPath: repoPath, provider: 'claude' });

      expect(() => manager.resumeSession(session.id)).toThrow(InvalidSessionTransitionError);
      expect(session.state).toBe('running');
    });

    it('rejects every transition once a session has ended', async () => {
      const session = await manager.createSession({ projectPath: repoPath, provider: 'claude' });
      manager.endSession(session.id);

      expect(() => manager.pauseSession(session.id)).toThrow(InvalidSessionTransitionError);
      expect(() => manager.resumeSession(session.id)).toThrow(InvalidSessionTransitionError);
      expect(() => manager.endSession(session.id)).toThrow(InvalidSessionTransitionError);
      expect(session.state).toBe('ended');
    });

    it('throws a descriptive error naming the session, its state, and the rejected action', async () => {
      const session = await manager.createSession({ projectPath: repoPath, provider: 'claude' });

      try {
        manager.resumeSession(session.id);
        expect.unreachable('resumeSession should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidSessionTransitionError);
        const transitionError = error as InvalidSessionTransitionError;
        expect(transitionError.sessionId).toBe(session.id);
        expect(transitionError.from).toBe('running');
        expect(transitionError.action).toBe('resume');
        expect(transitionError.message).toContain(session.id);
      }
    });

    it('rejects a lifecycle transition on an unknown session id', () => {
      expect(() => manager.pauseSession('does-not-exist')).toThrow(/no session/i);
      expect(() => manager.resumeSession('does-not-exist')).toThrow(/no session/i);
      expect(() => manager.endSession('does-not-exist')).toThrow(/no session/i);
    });
  });
});
