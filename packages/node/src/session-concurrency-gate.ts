/* ---------------------------------------------------------------------
 * Per-target concurrency caps with an overflow queue (SPEC §7.16; issue
 * #252): the single chokepoint `NodeDaemon` gates every session's launch
 * through, for both `local` and `ssh:` targets alike, so the accounting
 * logic lives in exactly one place rather than being reimplemented at each
 * of the two very different "launch" call sites (`AgentSupervisor.start()`
 * for `local`, a remote deploy-and-detach for `ssh:`).
 *
 * Deliberately synchronous and in-memory: a slot is either free or it
 * isn't, so there is nothing here worth making async. Callers own the
 * acquire/release pairing discipline (see {@link SessionConcurrencyGate.release}'s
 * doc comment) — this class only ever does the bookkeeping, never touches a
 * worktree, a process, or the wire.
 * --------------------------------------------------------------------- */

/** One session waiting for a slot on `targetId`, in the order it queued. */
interface QueuedEntry {
  targetId: string;
  sessionId: string;
  /** Invoked once {@link SessionConcurrencyGate.release} hands this entry the slot it was waiting for — never called synchronously from {@link SessionConcurrencyGate.enqueue} itself, and never called at all if {@link SessionConcurrencyGate.cancel} removes it first. */
  onDequeue: () => void;
}

export interface SessionConcurrencyGateOptions {
  /** Each target's concurrency cap, keyed by `TargetDescriptor.id`. A target id with no entry here (or later passed to {@link SessionConcurrencyGate.setMax}) falls back to `defaultMax`. */
  limits?: Record<string, number>;
  /**
   * The cap for a target id `limits` doesn't mention. Defaults to `1` — the
   * conservative floor: every real target this node exposes gets an
   * explicit entry from `NodeDaemon`'s constructor (a `local`-kind default
   * derived from this host's own core count, an `ssh:`-kind default from
   * `SshTargetConfig.maxConcurrentSessions` or its own conservative
   * fallback — see `./target.ts`), so this only matters for a target id
   * that somehow reaches {@link tryAcquire}/{@link enqueue} without ever
   * having been configured, which every real call site prevents by
   * resolving the target first.
   */
  defaultMax?: number;
}

/**
 * Owns the running-count and FIFO overflow queue for every target this node
 * exposes (SPEC §7.16, issue #252). One instance per `NodeDaemon`, shared
 * across every target id it knows about — not one gate per target — since
 * the caps themselves are just a `Map` keyed by target id underneath.
 *
 * The contract a caller (`NodeDaemon`) must hold up, since this class has
 * no way to enforce it itself:
 *
 * 1. Before launching a session on `targetId`, call {@link tryAcquire}. If
 *    it returns `true`, launch immediately — you now own one of that
 *    target's slots. If it returns `false`, do not launch; instead call
 *    {@link enqueue} with a callback that performs the exact same launch,
 *    to run later once a slot is handed to it.
 * 2. Whichever way a launch was obtained (immediate `tryAcquire` or a later
 *    `onDequeue`), call {@link release} exactly once when that session's
 *    slot is no longer needed — it finished, crashed, was killed, was
 *    explicitly stopped, or its launch itself failed after the slot was
 *    already reserved. Forgetting this leaks the slot forever (SPEC §7.16's
 *    whole point: an overflow queue that never drains is worse than no cap
 *    at all).
 * 3. A session that is still queued (its `onDequeue` hasn't run yet) may be
 *    withdrawn with {@link cancel} instead — it must never reach step 2,
 *    since it never held a slot to release.
 */
export class SessionConcurrencyGate {
  private readonly limits = new Map<string, number>();
  private readonly defaultMax: number;
  private readonly running = new Map<string, number>();
  private readonly queues = new Map<string, QueuedEntry[]>();
  private readonly queuedById = new Map<string, QueuedEntry>();

  constructor(options: SessionConcurrencyGateOptions = {}) {
    this.defaultMax = options.defaultMax ?? 1;
    for (const [targetId, max] of Object.entries(options.limits ?? {})) {
      this.limits.set(targetId, max);
    }
  }

  /** `targetId`'s currently configured cap — its own {@link setMax}/constructor-`limits` value, or `defaultMax`. */
  maxFor(targetId: string): number {
    return this.limits.get(targetId) ?? this.defaultMax;
  }

  /**
   * Reconfigures `targetId`'s cap. Only ever gates *future* {@link tryAcquire}
   * calls — a lower cap never touches sessions already running (SPEC §7.16:
   * "a cap lowered below the current running count must not kill running
   * sessions, it just stops new ones"), and does not by itself drain the
   * queue either way; the next {@link release} (or {@link tryAcquire}) simply
   * sees the new number. `NodeDaemon` doesn't yet expose a live way to call
   * this (that's the concurrency-limits UI, issue #255) — it's exercised
   * directly today, as the primitive a future live-reconfigure endpoint
   * would call verbatim.
   */
  setMax(targetId: string, max: number): void {
    this.limits.set(targetId, max);
  }

  /** How many sessions on `targetId` currently hold a slot. */
  runningCount(targetId: string): number {
    return this.running.get(targetId) ?? 0;
  }

  /** How many sessions on `targetId` are currently queued, waiting for a slot. */
  queuedCount(targetId: string): number {
    return this.queues.get(targetId)?.length ?? 0;
  }

  /** `targetId`'s queued session ids, oldest (next to start) first. */
  queuedSessionIds(targetId: string): string[] {
    return (this.queues.get(targetId) ?? []).map((entry) => entry.sessionId);
  }

  /**
   * Synchronously reserves one of `targetId`'s slots if its cap isn't
   * already reached. Returns whether it succeeded. See the class doc
   * comment for the acquire/release contract a caller must hold up once
   * this returns `true`.
   */
  tryAcquire(targetId: string): boolean {
    const current = this.runningCount(targetId);
    if (current >= this.maxFor(targetId)) return false;
    this.running.set(targetId, current + 1);
    return true;
  }

  /**
   * Queues `sessionId` (FIFO within `targetId`) after a failed
   * {@link tryAcquire}. `onDequeue` runs later, from inside a future
   * {@link release} call on this same `targetId` — never synchronously from
   * here — once this entry reaches the front and a slot is handed to it.
   */
  enqueue(targetId: string, sessionId: string, onDequeue: () => void): void {
    const entry: QueuedEntry = { targetId, sessionId, onDequeue };
    const queue = this.queues.get(targetId);
    if (queue) {
      queue.push(entry);
    } else {
      this.queues.set(targetId, [entry]);
    }
    this.queuedById.set(sessionId, entry);
  }

  /**
   * Withdraws `sessionId` from its target's queue before its turn came up
   * (SPEC §7.16's "cancellable while queued") — its `onDequeue` will now
   * never run, and it never launches. Returns `true` if it was actually
   * found still queued; `false` for a session that already started, already
   * finished, or was never queued at all (the honest "nothing to cancel
   * here" case, letting a caller like `NodeDaemon.handleSessionArchiveRequest`
   * call this unconditionally on every archive request without first
   * checking whether the session happens to be queued). Never touches any
   * target's running count — a queued session never held a slot to give
   * back.
   */
  cancel(sessionId: string): boolean {
    const entry = this.queuedById.get(sessionId);
    if (!entry) return false;
    this.queuedById.delete(sessionId);
    const queue = this.queues.get(entry.targetId);
    const index = queue?.indexOf(entry) ?? -1;
    if (queue && index >= 0) queue.splice(index, 1);
    return true;
  }

  /**
   * Releases one of `targetId`'s slots — see the class doc comment for
   * exactly when a caller owes this call. If `targetId`'s queue is
   * non-empty, the freed slot is handed straight to the oldest queued entry
   * instead of actually being freed: `runningCount(targetId)` is unchanged
   * (the slot transferred, it was never really vacant), `queuedCount(targetId)`
   * drops by one, and that entry's `onDequeue` runs synchronously, right
   * here — a caller whose `onDequeue` kicks off async work (every real one
   * does: spawning an agent) must not assume it has already settled by the
   * time this call returns. If the queue is empty, the slot is genuinely
   * freed and `runningCount(targetId)` drops by one.
   */
  release(targetId: string): void {
    const queue = this.queues.get(targetId);
    const next = queue?.shift();
    if (next) {
      this.queuedById.delete(next.sessionId);
      next.onDequeue();
      return;
    }
    const current = this.runningCount(targetId);
    this.running.set(targetId, Math.max(0, current - 1));
  }
}
