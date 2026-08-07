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
 * `SESSION_STATUS_LABELS`/`SESSION_STATUS_UNKNOWN_LABEL` reading, except
 * for `'error'`/`'paused'` with a `reason` the node sent (`RelayClient.
 * statusReasonFor` — a spawn that failed or timed out, or why a spend cap
 * paused it) or `'queued'` with a client-computed one (issue #255's
 * `target-concurrency.ts#queuePositionReasons` — this target's queue has
 * no wire-sent position, so the reason for `'queued'` is never a node
 * `reason` field, always that helper's own string), where the reason is
 * appended so a hover/hold on the row's own tooltip, the dot's accessible
 * name, or the status bar's own label reads WHY/HOW LONG, not just the
 * bare state. Hoisted here (out of `+page.svelte`, where it originated)
 * once a second surface needed the identical reading — same "one place a
 * status becomes words" rule this file's own doc comment already states.
 */
export function sessionStatusLabelWithReason(
  status: SessionStatusV1 | undefined,
  reason: string | undefined,
): string {
  if (!status) return SESSION_STATUS_UNKNOWN_LABEL;
  const label = SESSION_STATUS_LABELS[status];
  const reasonEligible = status === 'error' || status === 'paused' || status === 'queued';
  return reasonEligible && reason ? `${label}: ${reason}` : label;
}
