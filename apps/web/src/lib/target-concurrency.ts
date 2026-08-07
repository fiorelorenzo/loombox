import type { SessionStatusV1 } from '@loombox/protocol';

/**
 * Client-side answers to SPEC §7.16's "shows current load ... per target"
 * (issue #255) for the two figures the wire doesn't send outright: how many
 * of a target's sessions currently hold a concurrency slot vs. are waiting
 * for one, and — for one specific waiting session — its position in that
 * wait. Both are derived here from data every listed session already
 * carries (`nodeId`/`targetId`/its live `SessionStatusV1`/its status's own
 * transition timestamp), the same "no server call needed" trick
 * `+page.svelte`'s pre-existing `queuedSessionCount` (issue #730) already
 * uses account-wide; this module just adds the per-target grouping neither
 * that nor the wire's `SessionConcurrencyGate` (node-process-internal,
 * never serialized) provides today.
 *
 * Best-effort, not authoritative: `SLOT_HOLDING_STATUSES` is this file's
 * own approximation of "the node's `SessionConcurrencyGate` still holds
 * this session's slot", inferred from the same status vocabulary a badge
 * already reads rather than a live read of the gate itself. Good enough for
 * an at-a-glance count next to the target's cap; a caller that needs the
 * gate's own authoritative number has no substitute for the node reporting
 * it directly (not done here — see `packages/protocol/src/v1/targets.ts`'s
 * `targetDescriptor.maxConcurrentSessions` doc comment for what IS reported
 * directly, and why the running/queued counts aren't).
 */

/** The subset of `ClientSessionMeta` this module actually needs — narrowed so a caller doesn't have to construct a full session record for a test. */
export interface ConcurrencySession {
  id: string;
  nodeId: string;
  targetId: string;
}

/** `SessionStatusV1` values SPEC §7.16's `SessionConcurrencyGate` still holds a slot for — everything between a successful `tryAcquire`/dequeue and the `release()` a finish/crash/kill/stop triggers. `'queued'` is deliberately excluded: it is the one status the gate has NOT yet handed a slot to. */
const SLOT_HOLDING_STATUSES: ReadonlySet<SessionStatusV1> = new Set([
  'starting',
  'working',
  'awaiting_input',
  'permission_required',
  'paused',
]);

function targetKey(session: ConcurrencySession): string {
  return `${session.nodeId}:${session.targetId}`;
}

/** One target's best-effort concurrency snapshot — see this module's own doc comment for what "best-effort" means here. */
export interface TargetConcurrencySnapshot {
  running: number;
  queued: number;
}

/**
 * Groups `sessions` by target (`${nodeId}:${targetId}`, matching
 * `TargetStatusView.svelte`'s own `rowKey`) and counts how many currently
 * hold a slot vs. are queued, per {@link SLOT_HOLDING_STATUSES}. A target
 * with no session in either bucket is simply absent from the returned map
 * (an idle target isn't "0 running, 0 queued" worth rendering specially —
 * the caller's own `.get(key) ?? { running: 0, queued: 0 }` fallback covers
 * it identically).
 */
export function summarizeTargetConcurrency(
  sessions: readonly ConcurrencySession[],
  statusFor: (sessionId: string) => SessionStatusV1 | undefined,
): Map<string, TargetConcurrencySnapshot> {
  const result = new Map<string, TargetConcurrencySnapshot>();
  for (const session of sessions) {
    const status = statusFor(session.id);
    const holdsSlot = status !== undefined && SLOT_HOLDING_STATUSES.has(status);
    if (status !== 'queued' && !holdsSlot) continue;
    const key = targetKey(session);
    const entry = result.get(key) ?? { running: 0, queued: 0 };
    if (status === 'queued') entry.queued += 1;
    else entry.running += 1;
    result.set(key, entry);
  }
  return result;
}

/**
 * Every currently-`'queued'` session's own wait-position wording (issue
 * #255's "make the wait visible ... with its position") — `'position 2 of
 * 3 waiting for a slot'`, or the shorter `'waiting for a slot'` when it's
 * the only one on its target. Ranked oldest-first by
 * `RelayClient.statusUpdatedAtFor` (when this session transitioned to
 * `'queued'`), matching `SessionConcurrencyGate`'s own FIFO drain order — a
 * session queued earlier reads a lower (more reassuring, "closer to the
 * front") position. An unparsable/missing timestamp sorts as if it
 * transitioned at epoch 0 (oldest), and ties break on session id for a
 * result that never reorders between two calls with identical inputs.
 *
 * Returns a reason for every queued session unconditionally (never
 * `undefined` for one), so `sessionStatusLabelWithReason`'s "queued with a
 * reason gets it appended" behavior always fires for a session actually in
 * that state — a bare "Queued" with no wait context is exactly what issue
 * #255 calls out as indistinguishable from "slow".
 */
export function queuePositionReasons(
  sessions: readonly ConcurrencySession[],
  statusFor: (sessionId: string) => SessionStatusV1 | undefined,
  updatedAtFor: (sessionId: string) => string | undefined,
): Map<string, string> {
  const byTarget = new Map<string, ConcurrencySession[]>();
  for (const session of sessions) {
    if (statusFor(session.id) !== 'queued') continue;
    const key = targetKey(session);
    const group = byTarget.get(key);
    if (group) {
      group.push(session);
    } else {
      byTarget.set(key, [session]);
    }
  }

  const reasons = new Map<string, string>();
  for (const group of byTarget.values()) {
    const withTimestamps = group.map((session) => ({
      session,
      queuedAt: Date.parse(updatedAtFor(session.id) ?? '') || 0,
    }));
    withTimestamps.sort((a, b) => {
      if (a.queuedAt !== b.queuedAt) return a.queuedAt - b.queuedAt;
      return a.session.id.localeCompare(b.session.id);
    });
    const total = withTimestamps.length;
    withTimestamps.forEach(({ session }, index) => {
      reasons.set(
        session.id,
        total > 1 ? `position ${index + 1} of ${total} waiting for a slot` : 'waiting for a slot',
      );
    });
  }
  return reasons;
}
