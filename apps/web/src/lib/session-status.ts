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

/** Maps `SessionStatusV1` onto the shared `StatusDot` tone vocabulary. */
export const SESSION_STATUS_TONES: Record<SessionStatusV1, StatusTone> = {
  queued: 'neutral',
  starting: 'info',
  working: 'info',
  awaiting_input: 'neutral',
  permission_required: 'warning',
  error: 'danger',
  exited: 'neutral',
  disconnected: 'neutral',
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
};

/** The wording for a session the node has not reported a status for yet. */
export const SESSION_STATUS_UNKNOWN_LABEL = 'No status yet';
