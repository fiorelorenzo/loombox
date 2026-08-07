/**
 * Device-switch state preservation (issue #198, epic #6) — the pure,
 * DOM-free half of the feature. `RelayClient.sessionViewStateFor` fetches
 * and decrypts the wire payload; `+page.svelte` applies it (opens the
 * right canvas tab, feeds `TranscriptTimeline`'s `jumpTarget`) and
 * captures it back (composer draft, active tab, current reading
 * position). This module is the one piece of logic in between worth
 * testing without a Svelte component: "is this saved reading-position
 * anchor still trustworthy against what THIS device actually has".
 *
 * That is the "per-session invalidate" half of the Happy-inspired design
 * SPEC §7.3 calls out (`@loombox/protocol`'s `session-view-state.ts` own
 * doc comment has the full story). Concretely: a `lastViewedItemId` was
 * captured on some OTHER device, at some point in the session's history.
 * By the time THIS device reads it back, its own resynced transcript
 * (issue #729) is the only ground truth available to it — and the
 * relay's resync ring is bounded (SPEC §7.16's drop-oldest, surfaced
 * client-side as a `TranscriptGap` item). A session that has advanced far
 * enough while this device was away can mean the anchored item was
 * evicted before this device's own resync could ever recover it. Rather
 * than pass a dangling id to `TranscriptTimeline`'s `jumpTarget` (which
 * already no-ops silently on an unresolvable id — see that component's
 * own doc comment) or leave a caller to special-case "was it found",
 * this function makes the invalidation an explicit, testable step: the
 * stale anchor is dropped back to `undefined`, `TranscriptTimeline`'s own
 * default behavior (jumpTarget: undefined, pinned to the live tail).
 */
import type { SessionViewStatePayloadV1 } from '@loombox/protocol';
import type { TranscriptItem } from '@loombox/providers-core/browser';

/**
 * `payload` with a `lastViewedItemId` that no longer resolves against
 * `items` (this device's own currently-synced transcript) dropped back to
 * `undefined` — every other field passes through unchanged. A payload with
 * no anchor at all (the writing device was pinned to the live tail) is
 * already valid and returned as-is, without scanning `items`.
 */
export function invalidateStaleViewState(
  payload: SessionViewStatePayloadV1,
  items: readonly TranscriptItem[],
): SessionViewStatePayloadV1 {
  if (payload.lastViewedItemId === undefined) return payload;
  const stillResolves = items.some((item) => item.id === payload.lastViewedItemId);
  return stillResolves ? payload : { ...payload, lastViewedItemId: undefined };
}
