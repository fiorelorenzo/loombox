import type { CiAutoIterateStateV1, CiAutoIterateStopReasonV1 } from '@loombox/protocol';

/**
 * Decides whether a new CI failure actually drives a new agent turn, and
 * tracks the resulting loop's state (SPEC §7.14/§7.15; issue #246) — the
 * sibling of `ci-check-watcher.ts`, fully decoupled from `NodeDaemon`
 * exactly the same way: no session/bridge/spend-cap knowledge of its own,
 * only the two facts a caller already knows at the moment of each call
 * (whether this specific session is currently eligible to iterate, and
 * which commit a failure/pass reading was against). `NodeDaemon`'s own
 * `handleCiCheckFailure`/`onUpdate` wiring is what supplies those facts
 * and turns this class's decisions into `promptSession` calls and
 * `ci_auto_iterate_status` pushes — see that module's own doc comments.
 *
 * `CiCheckWatcher.onFailure` already dedupes "once per NEW failing
 * commit, not once per poll a failure happens to still be red on" (issue
 * #239's own acceptance) — this class never re-derives that; every
 * `onFailure` call here is assumed to already be a genuinely new failure.
 *
 * `CiAutoIterateStateV1` (from `@loombox/protocol`) is reused as-is for
 * this class's own in-memory snapshot shape, mirroring `ci-check.ts`'s
 * own `CiCheckStateV1` doing the same for `CiCheckWatcher`.
 */

export interface CiAutoIterateOptions {
  /** The bound `attempts` is never allowed to exceed within one loop — "never let it spin forever" (issue #246's own acceptance line). Defaults to 5. */
  maxAttempts?: number;
  now?: () => number;
}

/** One session's mutable loop bookkeeping — `CiAutoIterateController`'s own private half of `CiAutoIterateStateV1`; `userStopped` never reaches the wire directly (it's folded into `stoppedReason: 'user_stop'` instead, exactly like `CiCheckWatcher`'s own `notifiedFailureSha` never reaches `CiCheckStateV1`). */
interface SessionLoopRecord {
  attempts: number;
  history: Array<{ attempt: number; headSha: string; promptedAt: number }>;
  active: boolean;
  stoppedReason: CiAutoIterateStopReasonV1 | undefined;
  /** Sticky once set by {@link CiAutoIterateController.stopByUser} — cleared only by a green check ({@link CiAutoIterateController.onGreen}) or a fresh watch ({@link CiAutoIterateController.reset}), never by simply trying again on a later failure (unlike `'ineligible'`, which is deliberately NOT sticky — see this file's own module doc comment). */
  userStopped: boolean;
}

function freshRecord(): SessionLoopRecord {
  return { attempts: 0, history: [], active: false, stoppedReason: undefined, userStopped: false };
}

export class CiAutoIterateController {
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly records = new Map<string, SessionLoopRecord>();

  constructor(options: CiAutoIterateOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.now = options.now ?? Date.now;
  }

  private snapshot(record: SessionLoopRecord): CiAutoIterateStateV1 {
    return {
      active: record.active,
      attempts: record.attempts,
      maxAttempts: this.maxAttempts,
      stoppedReason: record.stoppedReason,
      history: [...record.history],
    };
  }

  /** `sessionId`'s current loop state — an untouched session (never watched, or watched but never yet failed) reads as a fresh, inactive, zero-attempt loop, not `undefined`; there is nothing invalid about a session `CiAutoIterateController` has simply never heard from yet. */
  getState(sessionId: string): CiAutoIterateStateV1 {
    return this.snapshot(this.records.get(sessionId) ?? freshRecord());
  }

  /** Starts `sessionId`'s loop clean — called from the same `NodeDaemon.registerCiCheckWatch` site that (re-)registers `CiCheckWatcher`'s own watch, so a brand new PR (or a session's very first one) never carries over a previous PR's attempt count or user-stop. */
  reset(sessionId: string): void {
    this.records.set(sessionId, freshRecord());
  }

  /** Forgets `sessionId` entirely — mirrors `CiCheckWatcher.unwatch`, called from the same session-archival site. */
  forget(sessionId: string): void {
    this.records.delete(sessionId);
  }

  /**
   * `CiCheckWatcher.onFailure` feeds this exactly once per NEW failing
   * commit. Three real reasons this returns `proceed: false` instead of
   * driving a new agent turn, checked in order:
   * 1. A prior `stopByUser()` — sticky.
   * 2. `attempts` already at `maxAttempts` — sticky.
   * 3. `eligible` is `false` — the caller's own up-to-the-moment read of
   *    whether this session is currently paused or over its effective
   *    spend cap (SPEC §7.16; issue #251). NOT sticky: unlike the two
   *    reasons above, an ineligible session can become eligible again at
   *    any moment (resumed, cap raised), and every new failure deserves
   *    a fresh look rather than inheriting a stale refusal.
   *
   * Returns the resulting state alongside the decision so a caller can
   * push both `promptSession` (when `proceed`) and `ci_auto_iterate_status`
   * from one call.
   */
  onFailure(
    sessionId: string,
    headSha: string,
    eligible: boolean,
  ): { proceed: boolean; state: CiAutoIterateStateV1 } {
    const record = this.records.get(sessionId) ?? freshRecord();
    this.records.set(sessionId, record);

    if (record.userStopped) {
      record.active = false;
      record.stoppedReason = 'user_stop';
      return { proceed: false, state: this.snapshot(record) };
    }
    if (record.attempts >= this.maxAttempts) {
      record.active = false;
      record.stoppedReason = 'max_attempts';
      return { proceed: false, state: this.snapshot(record) };
    }
    if (!eligible) {
      record.active = false;
      record.stoppedReason = 'ineligible';
      return { proceed: false, state: this.snapshot(record) };
    }

    record.attempts += 1;
    record.active = true;
    record.stoppedReason = undefined;
    record.history.push({ attempt: record.attempts, headSha, promptedAt: this.now() });
    return { proceed: true, state: this.snapshot(record) };
  }

  /**
   * `CiCheckWatcher.onUpdate` reports a genuinely green (`'passing'`)
   * poll — ends whatever loop was running and resets `attempts`/`history`
   * to zero so the NEXT new failure (a later commit, a flake) starts a
   * clean loop rather than inheriting a stale attempt count. Returns
   * `undefined` when nothing was actually active or attempted yet (an
   * already-idle session going green is not a state transition worth
   * pushing to a client) — a caller only pushes `ci_auto_iterate_status`
   * when this returns a real state.
   */
  onGreen(sessionId: string): CiAutoIterateStateV1 | undefined {
    const record = this.records.get(sessionId);
    if (!record || (!record.active && record.attempts === 0 && record.stoppedReason === undefined)) {
      return undefined;
    }
    const fresh = freshRecord();
    fresh.stoppedReason = 'green';
    this.records.set(sessionId, fresh);
    return this.snapshot(fresh);
  }

  /**
   * A client asked to stop `sessionId`'s loop right now (SPEC §7.14/
   * §7.15; issue #246's own "user-initiated" stop). Sticky (see
   * `SessionLoopRecord.userStopped`'s own doc comment) until a green
   * check or a fresh `reset()` — ends the loop immediately even if the
   * current failing commit is still red on the very next poll (already
   * deduped by `CiCheckWatcher` regardless, so that poll never reaches
   * this class again for the same commit).
   */
  stopByUser(sessionId: string): CiAutoIterateStateV1 {
    const record = this.records.get(sessionId) ?? freshRecord();
    record.userStopped = true;
    record.active = false;
    record.stoppedReason = 'user_stop';
    this.records.set(sessionId, record);
    return this.snapshot(record);
  }
}
