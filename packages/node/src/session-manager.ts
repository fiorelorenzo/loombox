import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { SessionStore } from './session-store';
import { SameFolderConflictError, SameFolderGuard } from './same-folder-guard';

const execFileAsync = promisify(execFile);

/** Re-exported so a caller catching a same-folder refusal doesn't need to import `./same-folder-guard.ts` directly. */
export { SameFolderConflictError };

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
  /** This session's own spend cap in USD (SPEC §7.16; issue #251) — the more specific of the two scopes `NodeDaemon.effectiveSpendCapUsd` resolves, beating the project-wide `SpendCapStore` value when both are set. `undefined` means this session has no cap of its own (falls back to the project cap, if any). Set via {@link SessionManager.setSpendCapUsd}; persisted through `SessionStore` exactly like every other `Session` field. */
  spendCapUsd: number | undefined;
}

/**
 * A session's lifecycle state (SPEC §7.1 "Sessions can be paused, resumed,
 * and reconnected"; issue #67). A freshly created session starts `'running'`
 * (its agent is spawned immediately by `NodeDaemon`, never created inert);
 * `'ended'` is terminal — no further transition is valid out of it.
 *
 * `'disconnected'` (issue #515) is the honest state a record loaded from a
 * `SessionStore`-backed manager's on-disk `sessions.json` comes back in: a
 * node restart means the agent process that made a saved `'running'` or
 * `'paused'` record true is simply gone, and pretending otherwise would let
 * a client believe it can resume into a live agent that no longer exists.
 * It is deliberately not `'ended'` — the session is still real (its
 * worktree/branch are still on disk, its row still belongs on the board)
 * and still needs to be listable and archivable so that worktree can
 * finally be cleaned up (the whole point of #515); it just cannot be
 * `pause`d/`resume`d back into life, since there is no agent behind it to
 * pause or resume — the only legal transition out of it is `end`, exactly
 * like `'ended'` itself already has none. A record already saved as
 * `'ended'` stays `'ended'` on reload: that state was already honest
 * regardless of the process that wrote it. See {@link assertValidTransition}
 * for the full transition table.
 */
export type SessionLifecycleState = 'running' | 'paused' | 'ended' | 'disconnected';

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
  disconnected: { end: 'ended' },
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
  /** Absolute path to the project folder to run the session against — does not have to be a git repository (SPEC §6); only isolating into a worktree (`workInPlace: false`, below) requires one. */
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

/**
 * Thrown by {@link assertIsGitRepo} when `projectPath` exists (see
 * {@link assertPathExists}) but isn't a git work tree — the refusal for
 * asking to isolate a session in a folder with nothing to branch a worktree
 * from. Exported, like {@link SameFolderConflictError} above, so a caller
 * can catch this refusal specifically instead of pattern-matching
 * `error.message`; SPEC §6/§7.1 makes this a normal, expected outcome for a
 * folder that simply isn't a repo, not a bug.
 */
export class NotAGitRepoError extends Error {
  constructor(readonly projectPath: string) {
    super(
      `not a git repository: ${projectPath} (an isolated worktree needs one; ` +
        'work in place instead, or initialize a repo first)',
    );
    this.name = 'NotAGitRepoError';
  }
}

/**
 * Thrown by {@link SessionManager.forkSession} when `sourceId` cannot be
 * forked as-is (design spec `2026-08-05-zed-parity-decisions.md` §3's C6-2;
 * issue #746) — never a half-created fork, always thrown before anything is
 * written to disk. Two cases: no session with `sourceId`; and a
 * `workInPlace` source (`branch === ''`, `worktreePath === projectPath`) —
 * there is no isolated worktree to copy FROM without touching the user's
 * actual project folder, and no branch to fork the new worktree's git
 * plumbing off of either. (An `ssh:` source is a third, related refusal,
 * but it's `NodeDaemon`'s to make, before it ever calls this method — see
 * {@link SessionManager.forkSession}'s own doc comment.)
 */
export class CannotForkSessionError extends Error {
  constructor(
    readonly sourceId: string,
    reason: string,
  ) {
    super(`SessionManager: cannot fork session ${sourceId}: ${reason}`);
    this.name = 'CannotForkSessionError';
  }
}

/**
 * Confirms `projectPath` exists at all, before anything below ever asks
 * whether it's a git repo. A missing directory and one that merely isn't a
 * repo are different problems with different fixes (issue #507): conflating
 * them — what this function's absence used to do, via `assertIsGitRepo`'s
 * old catch-all — reported a plain typo'd path as "not a git repository",
 * which is simply false.
 */
async function assertPathExists(projectPath: string): Promise<void> {
  try {
    await stat(projectPath);
  } catch {
    throw new Error(`project folder does not exist: ${projectPath}`);
  }
}

/**
 * Confirms `projectPath` is a git work tree. Only called when isolating
 * into a fresh worktree (SPEC §6: a project "does not have to be a git
 * repository" — true for working in place, but there is nothing to branch a
 * worktree off of otherwise); {@link SessionManager.createSession} never
 * calls this for `workInPlace`. Assumes the caller already ran
 * {@link assertPathExists}, so every failure here specifically means
 * "exists, but isn't a repo".
 */
async function assertIsGitRepo(projectPath: string): Promise<void> {
  try {
    const result = await execFileAsync('git', [
      '-C',
      projectPath,
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (result.stdout.trim() !== 'true') {
      throw new NotAGitRepoError(projectPath);
    }
  } catch (error) {
    if (error instanceof NotAGitRepoError) throw error;
    throw new NotAGitRepoError(projectPath);
  }
}

/**
 * Makes `<projectPath>/.loombox/` ignore itself, by writing the standard
 * self-ignoring `.gitignore` (`*`) into it before the first worktree lands.
 *
 * The class doc below used to say `.loombox/` "is expected to be git-ignored
 * by consuming projects", which quietly made every user responsible for
 * cleaning up after us: the node writes worktrees into their repo, so without
 * this the very first session leaves an untracked `.loombox/` in their
 * `git status` forever, and loombox's own repo was no exception (issue #507's
 * end-to-end check is what surfaced it). A directory that ignores itself
 * needs no cooperation from the project and cannot be forgotten.
 *
 * Never overwrites an existing file: a user who has deliberately committed
 * something under `.loombox/` keeps whatever rules they wrote. Failure is
 * non-fatal on purpose, since a dirty `git status` is a far smaller problem
 * than refusing to start the session the user actually asked for.
 */
async function ensureLoomboxDirIsSelfIgnoring(projectPath: string): Promise<void> {
  const dir = join(projectPath, '.loombox');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error) {
    // `EEXIST` is the normal steady state after the first session.
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return;
    console.warn(
      `SessionManager: could not make ${dir} self-ignoring: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Overwrites every top-level entry of `destWorktreePath` (a freshly
 * `git worktree add`-ed directory, `.git` itself never touched) with a
 * byte-for-byte copy of `sourceWorktreePath`'s current entries, `.git`
 * excluded on that side too — {@link SessionManager.forkSession}'s
 * worktree-fidelity half. Clearing the destination first (rather than only
 * copying over it) matters: `git worktree add` checks the fork's branch
 * tip out onto disk, and a file the source deleted but never committed
 * would otherwise survive the copy as a stray leftover from that checkout,
 * silently reintroducing something the transcript never claims exists.
 */
async function replaceWorktreeContents(
  sourceWorktreePath: string,
  destWorktreePath: string,
): Promise<void> {
  const destEntries = await readdir(destWorktreePath, { withFileTypes: true });
  await Promise.all(
    destEntries
      .filter((entry) => entry.name !== '.git')
      .map((entry) => rm(join(destWorktreePath, entry.name), { recursive: true, force: true })),
  );

  const sourceEntries = await readdir(sourceWorktreePath, { withFileTypes: true });
  await Promise.all(
    sourceEntries
      .filter((entry) => entry.name !== '.git')
      .map((entry) =>
        cp(join(sourceWorktreePath, entry.name), join(destWorktreePath, entry.name), {
          recursive: true,
        }),
      ),
  );
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
 *
 * **Same-folder safety (issue #68, SPEC §7.2):** a `workInPlace` session
 * reserves its `projectPath` in an internal {@link SameFolderGuard} for as
 * long as it's running, and {@link createSession} throws
 * {@link SameFolderConflictError} if another in-place session already holds
 * it — "two sessions may not run in place on the same folder at once". An
 * isolated-worktree session (the default, `workInPlace: false`) never
 * touches the guard at all: it gets its own subtree under
 * `<projectPath>/.loombox/worktrees/<sessionId>`, so any number of them can
 * coexist on the same project regardless of what's running in place — "using
 * worktrees removes the restriction".
 */
export interface SessionManagerOptions {
  /**
   * Persists this manager's session records across a process restart (issue
   * #515). Optional and `undefined` by default so every existing
   * `new SessionManager()` call — most of this file's own tests included —
   * keeps its original memory-only behavior with zero disk I/O; only a
   * caller (`NodeDaemon`) that actually wants restart survival wires one in.
   */
  store?: SessionStore;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly sameFolderGuard = new SameFolderGuard();
  private readonly store?: SessionStore;

  constructor(options: SessionManagerOptions = {}) {
    this.store = options.store;
    for (const loaded of this.store?.load() ?? []) {
      // Reload on boot (issue #515): a record saved as 'running'/'paused'
      // described a live agent process that died with the previous node
      // process — see `SessionLifecycleState`'s doc comment for why
      // 'disconnected', not 'ended', is the honest state to bring it back
      // in. A record already 'ended' needs no rewriting; that was already
      // true regardless of which process wrote it.
      const session =
        loaded.state === 'ended' ? loaded : { ...loaded, state: 'disconnected' as const };
      this.sessions.set(session.id, session);
    }
  }

  /** Writes the manager's complete current record set to `store`, if one was configured. A no-op otherwise — see `SessionManagerOptions.store`'s doc comment. */
  private persist(): void {
    this.store?.save([...this.sessions.values()]);
  }

  async createSession({
    projectPath,
    provider,
    id: givenId,
    nodeId,
    targetId,
    workInPlace = false,
  }: CreateSessionOptions): Promise<Session> {
    await assertPathExists(projectPath);

    const id = givenId ?? randomUUID();

    let worktreePath: string;
    let branch: string;
    if (workInPlace) {
      // SPEC §6/§7.1: working in place never requires a git repository —
      // only isolating into a worktree (the `else` below) does, since
      // there's nothing to branch one off of otherwise (issue #507).
      // Reserve before creating anything: a refusal here is cheap (nothing
      // was touched yet) and leaves no partial state to clean up, unlike a
      // conflict discovered after `git worktree add` had already run.
      this.sameFolderGuard.reserve(projectPath, id);
      worktreePath = projectPath;
      branch = '';
    } else {
      await assertIsGitRepo(projectPath);
      branch = sessionWorktreeBranch(id);
      worktreePath = join(projectPath, '.loombox', 'worktrees', id);
      await ensureLoomboxDirIsSelfIgnoring(projectPath);
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
      spendCapUsd: undefined,
    };

    this.sessions.set(id, session);
    this.persist();
    return session;
  }

  /**
   * Forks `sourceId` into a brand-new, independent session (design spec
   * `2026-08-05-zed-parity-decisions.md` §3's C6-2; issue #746). Never
   * writes to `sourceId`'s own record, worktree, or branch — this only
   * reads from them. Throws {@link CannotForkSessionError}, before
   * anything is created on disk, for a source this manager cannot fork:
   * unknown id, or `workInPlace` (no isolated worktree/branch to fork
   * from). There is no separate non-`local`-target check here: this
   * manager only ever holds `local` sessions in the first place (an
   * `ssh:` session is tracked by `NodeDaemon` directly, never recorded
   * here — see `Session.target`'s own doc comment) — the caller
   * (`NodeDaemon.forkSessionInternal`) is what refuses an `ssh:` source
   * before ever reaching this method.
   *
   * Worktree fidelity: see {@link replaceWorktreeContents}'s doc comment
   * for the "why not branch off a commit" reasoning in full. In short,
   * `git worktree add -b branch worktreePath <source's own branch>`
   * establishes real, independent git worktree plumbing (so every other
   * worktree-keyed capability — teardown, the diff viewer, a future
   * checkpoint engine — sees a normal session), and
   * {@link replaceWorktreeContents} then overwrites its checked-out files
   * with an exact copy of the source's CURRENT disk state, uncommitted and
   * untracked changes included — the part a bare branch-off would silently
   * drop, and the part that actually matters, since an agent's edits are
   * usually uncommitted.
   */
  async forkSession(
    sourceId: string,
    options: { id?: string; provider: string; nodeId?: string; targetId?: string },
  ): Promise<Session> {
    const source = this.sessions.get(sourceId);
    if (!source) {
      throw new CannotForkSessionError(sourceId, 'no such session');
    }
    if (!source.branch) {
      throw new CannotForkSessionError(
        sourceId,
        'the source session runs in place (workInPlace), with no isolated worktree of its own to fork from',
      );
    }

    const id = options.id ?? randomUUID();
    const branch = sessionWorktreeBranch(id);
    const worktreePath = join(source.projectPath, '.loombox', 'worktrees', id);
    await ensureLoomboxDirIsSelfIgnoring(source.projectPath);
    await runGit(
      ['worktree', 'add', '-b', branch, worktreePath, source.branch],
      source.projectPath,
    );
    await replaceWorktreeContents(source.worktreePath, worktreePath);

    const session: Session = {
      id,
      projectPath: source.projectPath,
      worktreePath,
      target: 'local',
      provider: options.provider,
      branch,
      createdAt: Date.now(),
      state: 'running',
      nodeId: options.nodeId,
      targetId: options.targetId ?? 'local',
      // Deliberately NOT inherited from `source` — a fork is "a brand-new,
      // independent session" (this method's own doc comment); its spend
      // cap starts unset (falling back to the project cap, if any) rather
      // than silently carrying the source's own session-scoped limit.
      spendCapUsd: undefined,
    };

    this.sessions.set(id, session);
    this.persist();
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
    this.persist();
    return session;
  }

  /** Transitions a `'paused'` session back to `'running'`. Throws {@link InvalidSessionTransitionError} if it isn't currently `'paused'` (e.g. it was never paused, or it already ended). */
  resumeSession(id: string): Session {
    const session = this.requireSession(id);
    applyTransition(session, 'resume');
    this.persist();
    return session;
  }

  /** Sets or clears (via `undefined`) this session's own spend cap in USD (SPEC §7.16; issue #251) — the session-scoped half of the two-scope resolution `NodeDaemon.effectiveSpendCapUsd` performs. Throws a plain `Error` (mirrors {@link requireSession}'s own unchecked-id contract) for an unknown session id, or for a `capUsd` that isn't a positive, finite number — a $0 or negative cap is not a real spend limit, same validation `SpendCapStore.save()` applies to the project scope. Setting a cap never itself pauses or resumes a session; `NodeDaemon` re-evaluates the effective cap against the session's live cost on its own next `usage_update`/attention transition, and separately auto-resumes a cap-paused session when the newly-set cap now exceeds its current spend (see `NodeDaemon.maybeAutoResumeAfterCapChange`). */
  setSpendCapUsd(id: string, capUsd: number | undefined): Session {
    const session = this.requireSession(id);
    if (capUsd !== undefined && !(Number.isFinite(capUsd) && capUsd > 0)) {
      throw new Error(
        `SessionManager: cannot set spend cap for session ${id}: ${capUsd} is not a positive, finite number`,
      );
    }
    session.spendCapUsd = capUsd;
    this.persist();
    return session;
  }

  /** Transitions a `'running'` or `'paused'` session to the terminal `'ended'` state. Throws {@link InvalidSessionTransitionError} if it has already ended. Does not remove the session record or its worktree — see {@link removeSession} for that. Releases this session's same-folder reservation (issue #68), if it held one, so a new in-place session on the same folder can start. */
  endSession(id: string): Session {
    const session = this.requireSession(id);
    applyTransition(session, 'end');
    if (!session.branch) {
      this.sameFolderGuard.release(session.projectPath, id);
    }
    this.persist();
    return session;
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`no session with id ${id}`);
    }
    return session;
  }

  /**
   * Removes a session's record, tearing down its isolated worktree and
   * branch by default. Passing `removeWorktree: false` (SPEC §7.2's
   * archive-without-cleanup choice, issue #512) instead just forgets the
   * record and leaves disk exactly as it already was — for archiving a
   * session whose worktree a caller deliberately wants to keep poking at.
   *
   * A `workInPlace` (or, for an `ssh:` session recorded directly by
   * `NodeDaemon`, worktree-less) session has `branch === ''` and its
   * `worktreePath` *is* `projectPath` — there is no worktree to remove,
   * and `git worktree remove`/`rm -rf` on `projectPath` itself would
   * destroy the user's actual working copy, so this never touches disk
   * for one regardless of `removeWorktree`. Either no-disk case still
   * releases the session's same-folder reservation (issue #68) — a
   * force-remove can happen on a still-`running` session (never went
   * through `endSession`), so this is the only release path guaranteed to
   * run for it.
   */
  async removeSession(id: string, options: { removeWorktree?: boolean } = {}): Promise<void> {
    const { removeWorktree = true } = options;
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`no session with id ${id}`);
    }

    if (!session.branch || !removeWorktree) {
      this.sameFolderGuard.release(session.projectPath, id);
      this.sessions.delete(id);
      this.persist();
      return;
    }

    try {
      await runGit(['worktree', 'remove', '--force', session.worktreePath], session.projectPath);
      // Only deletable once nothing has it checked out — `git branch -D`
      // refuses outright on a branch still attached to a worktree, so this
      // must run after the remove above succeeds, never before or in
      // parallel (issue #512: without this, the repo accumulates one
      // `loombox/session-*` branch per session forever, since nothing else
      // ever prunes them).
      await runGit(['branch', '-D', session.branch], session.projectPath);
    } finally {
      // Belt-and-suspenders: `git worktree remove` already deletes the
      // directory, but if it failed partway (or the dir was left behind)
      // make sure removeSession is idempotent about disk state.
      await rm(session.worktreePath, { recursive: true, force: true });
      this.sessions.delete(id);
      this.persist();
    }
  }
}
