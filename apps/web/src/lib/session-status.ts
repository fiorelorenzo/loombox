import type { SessionStatusV1 } from '@loombox/protocol';
import { type StatusTone } from '$lib/components/ui/StatusDot.svelte';

/**
 * The one place a session's status becomes something a person reads
 * (redesign v3 design spec §3.2). Hoisted out of `+page.svelte` because
 * the sidebar, the command palette, the attention inbox and the session-row
 * menu all describe the same states, and they used to disagree: the
 * sidebar's badge printed the raw enum (`PERMISSION_REQUIRED`, wide enough to
 * overflow its own row) while the `StatusDot` beside it carried the readable
 * label. Every surface reads these two maps; none re-derives wording from the
 * enum.
 *
 * Keyed by the protocol's `SessionStatusV1` (8 values), not
 * `@loombox/providers-core`'s narrower `AcpSessionStatus` (5 values) —
 * `StatusDot`'s own doc comment already says call sites "map their own
 * status vocabulary (`SessionStatusV1`...)" onto its plain `tone`/`pulse`
 * pair, and `relay-client.ts`'s `parseSessionWireEvent` explains why the
 * two unions differ in the first place: "`session_status.status` is
 * `SessionStatusV1` on the protocol side (its own wider [...] enum,
 * including 'queued'/'starting') while `AcpSessionStatus` [...] is still
 * the narrower [...] union; the reducer's `case 'session_status'` [...]
 * already stores whichever string arrives unchecked either way." Keying
 * these two maps off the narrower union left `'queued'`/`'starting'`
 * falling through to `undefined` here (a real, pre-existing hole — a
 * queued/starting session's row title read literally "undefined"); adding
 * `'disconnected'` (issue #702) the same way would have silently hit the
 * same hole a third time. One map widening fixes all three at once,
 * matching what `StatusDot` already expected callers to do.
 */

/**
 * Maps `SessionStatusV1` onto the shared `StatusDot` tone vocabulary.
 * `'paused'` (SPEC §7.16's spend caps, issue #251) shares `'warning'`
 * with `'permission_required'` — both are "needs a decision" states, not
 * failures — but the two are never actually confusable in practice: a
 * `'paused'` session always carries a `reason` (see
 * `sessionStatusLabelWithReason` below), so its label/tooltip/aria-name
 * reads "Paused: Spend cap reached ..." rather than the bare tone alone
 * having to carry the distinction.
 */
export const SESSION_STATUS_TONES: Record<SessionStatusV1, StatusTone> = {
  queued: 'neutral',
  starting: 'info',
  working: 'info',
  awaiting_input: 'neutral',
  permission_required: 'warning',
  error: 'danger',
  exited: 'neutral',
  disconnected: 'neutral',
  paused: 'warning',
};

/** Short, human status wording — what a badge, a tooltip or an `aria-label` shows. */
export const SESSION_STATUS_LABELS: Record<SessionStatusV1, string> = {
  queued: 'Queued',
  starting: 'Starting…',
  working: 'Working',
  awaiting_input: 'Awaiting you',
  permission_required: 'Needs permission',
  error: 'Error',
  exited: 'Exited',
  disconnected: 'Disconnected',
  paused: 'Paused',
};

/** The wording for a session the node has not reported a status for yet. */
export const SESSION_STATUS_UNKNOWN_LABEL = 'No status yet';

/**
 * The row/selvage badge's status text (issue #730), and the status bar's
 * own session segment (issue #736): the plain
 * `SESSION_STATUS_LABELS`/`SESSION_STATUS_UNKNOWN_LABEL` reading, with a
 * reason appended whenever the caller has one, so a hover/hold on the
 * row's own tooltip, the dot's accessible name, or the status bar's own
 * label reads WHY/HOW LONG, not just the bare state. Hoisted here (out of
 * `+page.svelte`, where it originated) once a second surface needed the
 * identical reading — same "one place a status becomes words" rule this
 * file's own doc comment already states.
 *
 * `reason` comes from one of three producers, each already scoped to the
 * right status before it ever reaches here (this function trusts the
 * caller rather than re-gating by status — see below for why that
 * changed): the node's own `RelayClient.statusReasonFor` (`'error'` — a
 * spawn that failed or timed out or, since issue #271, a mid-session
 * crash message; `'paused'` — why a spend cap fired; `'exited'`, issue
 * #271 — the process's own exit code); issue #255's client-computed
 * `target-concurrency.ts#queuePositionReasons` for `'queued'` (the wire
 * never sends a queue position, so this one is never a node `reason`);
 * and issue #271's own client-computed `session-stall-diagnosis.ts#diagnoseSessionStall`
 * for whichever of `'starting'`/`'working'`/`'awaiting_input'`/
 * `'permission_required'`/`'disconnected'` its `'target_unreachable'`/
 * `'agent_unavailable'` causes apply to — its `'unknown'` cause is
 * deliberately never turned into a `reason` string by its own caller (see
 * that module's doc comment: reporting "unknown" as a guessed "thinking"
 * or "wedged" is exactly what issue #271 exists to stop), so a session
 * with nothing distinguishing to say here still reads as plain
 * `'Working'`/etc., same as before any of this existed.
 *
 * Used to gate on a fixed `status === 'error' || 'paused' || 'queued'`
 * whitelist, back when those were the only three producers of a `reason`
 * at all; issue #271 adds legitimate producers for four more statuses, at
 * which point a hand-maintained whitelist is one more place to forget to
 * update, not a safety net — every producer above already scopes itself
 * to the right status, so this function now just appends whatever it's
 * given.
 */
export function sessionStatusLabelWithReason(
  status: SessionStatusV1 | undefined,
  reason: string | undefined,
): string {
  if (!status) return SESSION_STATUS_UNKNOWN_LABEL;
  const label = SESSION_STATUS_LABELS[status];
  return reason ? `${label}: ${reason}` : label;
}
