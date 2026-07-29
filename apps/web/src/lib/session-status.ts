import type { AcpSessionStatus } from '@loombox/providers-core/browser';
import { type StatusTone } from '$lib/components/ui/StatusDot.svelte';

/**
 * The one place a session's `AcpSessionStatus` becomes something a person
 * reads (redesign v3 design spec §3.2). Hoisted out of `+page.svelte` because
 * the sidebar, the command palette, the attention inbox and the session-row
 * menu all describe the same five states, and they used to disagree: the
 * sidebar's badge printed the raw enum (`PERMISSION_REQUIRED`, wide enough to
 * overflow its own row) while the `StatusDot` beside it carried the readable
 * label. Every surface reads these two maps; none re-derives wording from the
 * enum.
 */

/** Maps `AcpSessionStatus` onto the shared `StatusDot` tone vocabulary. */
export const SESSION_STATUS_TONES: Record<AcpSessionStatus, StatusTone> = {
  working: 'info',
  awaiting_input: 'neutral',
  permission_required: 'warning',
  error: 'danger',
  exited: 'neutral',
};

/** Short, human status wording — what a badge, a tooltip or an `aria-label` shows. */
export const SESSION_STATUS_LABELS: Record<AcpSessionStatus, string> = {
  working: 'Working',
  awaiting_input: 'Awaiting you',
  permission_required: 'Needs permission',
  error: 'Error',
  exited: 'Exited',
};

/** The wording for a session the node has not reported a status for yet. */
export const SESSION_STATUS_UNKNOWN_LABEL = 'No status yet';
