import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * A running (or paused) agent working inside one workspace derived from a
 * project (SPEC §6). v0 only supports the `local` execution target: the
 * agent runs on the same machine as the node, in an isolated git worktree.
 */
export interface Session {
  id: string;
  projectPath: string;
  worktreePath: string;
  target: 'local';
  provider: string;
  branch: string;
  createdAt: number;
}

export interface CreateSessionOptions {
  /** Absolute path to a local git repository to run the session against. */
  projectPath: string;
  /** Provider id (e.g. 'claude', 'codex'); opaque to the session manager. */
  provider: string;
  /**
   * Use this id instead of generating a fresh `randomUUID()` (v1,
   * `@loombox/node`'s `NodeDaemon`: a client-initiated `session_create`
   * already picked the session id itself, since it must derive that
   * session's E2E key and seal the private envelope *before* the node has
   * said anything back — SPEC §8's key-tree design, where any device holding
   * the AMK derives a resource's key with no coordination). Omit for the v0
   * behavior of generating a fresh id.
   */
  id?: string;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${message}`);
  }
}

async function assertIsGitRepo(projectPath: string): Promise<void> {
  try {
    const result = await execFileAsync('git', [
      '-C',
      projectPath,
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (result.stdout.trim() !== 'true') {
      throw new Error(`not a git repository: ${projectPath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('not a git repository')) {
      throw error;
    }
    throw new Error(`not a git repository: ${projectPath}`);
  }
}

/**
 * Owns in-memory `Session` records and the git worktrees that back them, for
 * the `local` execution target only (SPEC §5.2, §6, §7.1).
 *
 * Worktree placement: each session's worktree is created under
 * `<projectPath>/.loombox/worktrees/<sessionId>`. Keeping worktrees inside
 * the project (rather than under os.tmpdir()) means they live next to the
 * repo they belong to, survive a node restart on the same disk, and are
 * trivially discoverable/cleanable by the user; `.loombox/` is expected to be
 * git-ignored by consuming projects. Each worktree is created on a fresh
 * branch named `loombox/session-<sessionId>`, branched from the repo's
 * current HEAD.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  async createSession({
    projectPath,
    provider,
    id: givenId,
  }: CreateSessionOptions): Promise<Session> {
    await assertIsGitRepo(projectPath);

    const id = givenId ?? randomUUID();
    const branch = `loombox/session-${id}`;
    const worktreePath = join(projectPath, '.loombox', 'worktrees', id);

    await runGit(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], projectPath);

    const session: Session = {
      id,
      projectPath,
      worktreePath,
      target: 'local',
      provider,
      branch,
      createdAt: Date.now(),
    };

    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  async removeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`no session with id ${id}`);
    }

    try {
      await runGit(['worktree', 'remove', '--force', session.worktreePath], session.projectPath);
    } finally {
      // Belt-and-suspenders: `git worktree remove` already deletes the
      // directory, but if it failed partway (or the dir was left behind)
      // make sure removeSession is idempotent about disk state.
      await rm(session.worktreePath, { recursive: true, force: true });
      this.sessions.delete(id);
    }
  }
}
