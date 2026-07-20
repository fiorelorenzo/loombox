/**
 * Same-folder safety (issue #68, SPEC §7.2): "because a project can be a
 * plain folder with no worktree, two sessions may not run in place on the
 * same folder at once — the second is queued or refused with a warning;
 * using worktrees removes the restriction." This module is the refusal
 * mechanism; it's the caller's job (`./session-manager.ts` for `local`
 * sessions, `./node-daemon.ts` for `ssh:` sessions) to only ever consult it
 * for an in-place session — a worktree session never reserves anything here,
 * since it gets its own subtree of the folder and can never contend with
 * another session on disk.
 *
 * Deliberately just a `Map<key, sessionId>` behind a small reserve/release
 * API, in-memory and per-process — not persisted, matching every other
 * node-local runtime bookkeeping in this package (`SshTransportPool`,
 * `SessionLeaseManager`'s in-memory map for the single-node v1 case). `key`
 * is caller-derived: `./session-manager.ts` uses a bare `projectPath`
 * (it only ever creates `local` sessions, one physical filesystem); `./node
 * -daemon.ts` uses `` `${targetId}:${projectPath}` `` for its `ssh:` sessions,
 * since the same path string can name genuinely different folders on
 * different remote hosts.
 */
export class SameFolderConflictError extends Error {
  constructor(
    readonly key: string,
    readonly heldBySessionId: string,
  ) {
    super(
      `an in-place session (${heldBySessionId}) is already running on this folder; ` +
        'use a worktree to run a second session on it, or wait for the running one to finish (SPEC §7.2)',
    );
    this.name = 'SameFolderConflictError';
  }
}

export class SameFolderGuard {
  private readonly heldBy = new Map<string, string>();

  /**
   * Reserves `key` for `sessionId`. Throws {@link SameFolderConflictError} if
   * another session already holds it. Reserving a key a session already
   * holds itself is a harmless no-op (idempotent), never a conflict with
   * itself.
   */
  reserve(key: string, sessionId: string): void {
    const existing = this.heldBy.get(key);
    if (existing !== undefined && existing !== sessionId) {
      throw new SameFolderConflictError(key, existing);
    }
    this.heldBy.set(key, sessionId);
  }

  /**
   * Releases `key`, but only if it's currently held by `sessionId` — a
   * stale or foreign release (e.g. a session that never held it, or one that
   * already lost the reservation to a bug elsewhere) is a silent no-op
   * rather than able to release someone else's active reservation. Safe to
   * call more than once for the same session (idempotent).
   */
  release(key: string, sessionId: string): void {
    if (this.heldBy.get(key) === sessionId) {
      this.heldBy.delete(key);
    }
  }

  /** Whether `key` currently has an in-place session holding it. */
  isHeld(key: string): boolean {
    return this.heldBy.has(key);
  }
}
