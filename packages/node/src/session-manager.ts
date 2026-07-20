import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * A running (or paused) agent working inside one workspace derived from a
 * project (SPEC §6). `SessionManager` itself (below) only ever constructs
 * `target: 'local'` sessions, each in an isolated git worktree; `target`
 * also allows `'ssh'` so `NodeDaemon` can return the same shape for an
 * `ssh:` target's session (issue #80) without a second parallel type. An
 * `ssh:` session's `worktreePath` equals its `projectPath` (no per-session
 * remote git worktree is created in this wave — see `NodeDaemon`'s ssh
 * session-creation path) and `branch` is `''` (no remote branch management
 * either); both are genuinely N/A for `ssh:`, not lies, just the honest
 * shape of "nothing to report here yet".
 */
export interface Session {
  id: string;
  projectPath: string;
  worktreePath: string;
  target: 'local' | 'ssh';
  provider: string;
  branch: string;
  createdAt: number;
  /** This session's lifecycle state (issue #67); see {@link SessionLifecycleState}. */
  state: SessionLifecycleState;
  /** The node id that owns this session (SPEC §5.1/§6; issue #67's "node ... association per session"). `undefined` when the caller didn't supply one (e.g. a bare `SessionManager` used outside `NodeDaemon`). */
  nodeId: string | undefined;
  /** The specific `TargetDescriptor.id` (e.g. `'local'`, or an `ssh:` target's id) this session runs on — distinct from `target`, which only records the target *kind*. `undefined` when the caller didn't supply one. */
  targetId: string | undefined;
}

/**
 * A session's lifecycle state (SPEC §7.1 "Sessions can be paused, resumed,
 * and reconnected"; issue #67). A freshly created session starts `'running'`
 * (its agent is spawned immediately by `NodeDaemon`, never created inert);
 * `'ended'` is terminal — no further transition is valid out of it. See
 * {@link assertValidTransition} for the full transition table.
 */
export type SessionLifecycleState = 'running' | 'paused' | 'ended';

/** A lifecycle transition {@link SessionManager} rejects (e.g. resuming a session that was never paused, or any transition out of `'ended'`). */
export class InvalidSessionTransitionError extends Error {
  constructor(
    readonly sessionId: string,
    readonly from: SessionLifecycleState,
    readonly action: 'pause' | 'resume' | 'end',
  ) {
    super(`SessionManager: cannot ${action} session ${sessionId}: it is currently "${from}"`);
    this.name = 'InvalidSessionTransitionError';
  }
}

const VALID_TRANSITIONS: Record<
  SessionLifecycleState,
  Partial<Record<'pause' | 'resume' | 'end', SessionLifecycleState>>
> = {
  running: { pause: 'paused', end: 'ended' },
  paused: { resume: 'running', end: 'ended' },
  ended: {},
};

/** Validates and applies one lifecycle transition on `session` in place, or throws {@link InvalidSessionTransitionError}. The sole source of truth for which transitions are legal — see the module doc comment for the state diagram this encodes. */
function applyTransition(session: Session, action: 'pause' | 'resume' | 'end'): void {
  const next = VALID_TRANSITIONS[session.state][action];
  if (!next) {
    throw new InvalidSessionTransitionError(session.id, session.state, action);
  }
  session.state = next;
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
  /** The owning node's id (issue #67); recorded on the session, not otherwise used by `SessionManager`. */
  nodeId?: string;
  /** The specific target id this session runs on; recorded on the session, not otherwise used by `SessionManager`. Defaults to `'local'`, since a bare `SessionManager` only ever creates `local`-kind sessions. */
  targetId?: string;
  /**
   * Skip creating an isolated git worktree and run directly in `projectPath`
   * instead (issue #75, SPEC §6: "Worktree (optional)... The user chooses
   * per session; worktree is not mandatory"). Defaults to `false` (an
   * isolated worktree, `SessionManager`'s original and only behavior before
   * this option existed). When `true`, `worktreePath` equals `projectPath`
   * and `branch` is `''` — the same "genuinely N/A" shape an `ssh:` session
   * without a remote worktree already uses (see the `Session` doc comment).
   */
  workInPlace?: boolean;
}

/** The branch name a session's isolated worktree is created on, on either target kind — `local` computes it right here; `ssh:` targets pass it to `./ssh/remote-worktree.ts`'s `createRemoteWorktree` so both stay byte-for-byte identical. */
export function sessionWorktreeBranch(sessionId: string): string {
  return `loombox/session-${sessionId}`;
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
    nodeId,
    targetId,
    workInPlace = false,
  }: CreateSessionOptions): Promise<Session> {
    await assertIsGitRepo(projectPath);

    const id = givenId ?? randomUUID();

    let worktreePath: string;
    let branch: string;
    if (workInPlace) {
      worktreePath = projectPath;
      branch = '';
    } else {
      branch = sessionWorktreeBranch(id);
      worktreePath = join(projectPath, '.loombox', 'worktrees', id);
      await runGit(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], projectPath);
    }

    const session: Session = {
      id,
      projectPath,
      worktreePath,
      target: 'local',
      provider,
      branch,
      createdAt: Date.now(),
      state: 'running',
      nodeId,
      targetId: targetId ?? 'local',
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

  /** Transitions a `'running'` session to `'paused'`. Throws {@link InvalidSessionTransitionError} if it isn't currently `'running'` (including if it's already `'ended'`). */
  pauseSession(id: string): Session {
    const session = this.requireSession(id);
    applyTransition(session, 'pause');
    return session;
  }

  /** Transitions a `'paused'` session back to `'running'`. Throws {@link InvalidSessionTransitionError} if it isn't currently `'paused'` (e.g. it was never paused, or it already ended). */
  resumeSession(id: string): Session {
    const session = this.requireSession(id);
    applyTransition(session, 'resume');
    return session;
  }

  /** Transitions a `'running'` or `'paused'` session to the terminal `'ended'` state. Throws {@link InvalidSessionTransitionError} if it has already ended. Does not remove the session record or its worktree — see {@link removeSession} for that. */
  endSession(id: string): Session {
    const session = this.requireSession(id);
    applyTransition(session, 'end');
    return session;
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`no session with id ${id}`);
    }
    return session;
  }

  async removeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`no session with id ${id}`);
    }

    // A `workInPlace` (or, for an `ssh:` session recorded directly by
    // `NodeDaemon`, worktree-less) session has `branch === ''` and its
    // `worktreePath` *is* `projectPath` — there is no worktree to remove,
    // and `git worktree remove`/`rm -rf` on `projectPath` itself would
    // destroy the user's actual working copy. Just forget the record.
    if (!session.branch) {
      this.sessions.delete(id);
      return;
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
