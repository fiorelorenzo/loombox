/**
 * Shared derivations over a session's current plan (`TranscriptState.plan`,
 * SPEC.md §7.24 "Plans, rendered twice from one truth"). ACP replaces a
 * plan's entire entry list on every `plan_update` — never diffed
 * client-side — so there is exactly one current plan per session at any
 * moment, and both renderers (`PlanCard.svelte`'s inline card,
 * `PlanSidebar.svelte`'s persistent grouped view, issue #201) read it
 * straight off `transcript.plan` and pass it through the functions below.
 * Nothing here owns state or a subscription; both are pure functions over
 * whatever `AcpPlanEntry[]` the caller already has, so "the sidebar and the
 * card agree" is a property of sharing this code, not of the two views
 * happening to compute the same thing twice.
 *
 * `planProgress`'s `{completed, total}` pair is the "N of M items left"
 * figure SPEC.md §7.24's own plans bullet says to also feed the attention
 * inbox (§7.13) with. No `AttentionInboxItem` kind exists for that yet —
 * every kind that union carries today is wired to a live event source
 * (`RelayClient.recomputeAttentionInbox`'s own doc comment), and adding an
 * unwired one is exactly the `'review_request'` precedent that component
 * documents as its own separate, later issue. This function is exported
 * from `$lib` (not inlined in either component) so that later wiring reuses
 * this exact computation instead of a second, possibly-divergent count.
 */
import type { AcpPlanEntry } from '@loombox/providers-core/browser';

/** The plan's completion figure: `completed` of `total` entries have reached `'completed'`. `total - completed` is the "N items left" half of SPEC.md §7.24's "N of M items left" — kept as the two raw counts rather than a pre-subtracted "left" figure, since every current caller (the card's `{completed}/{entries.length}` header, the sidebar's completion bar) wants "done of total," not "remaining." */
export interface PlanProgress {
  readonly completed: number;
  readonly total: number;
}

/** `entries.filter(status === 'completed').length` plus the total — the exact expression `PlanCard.svelte` used to inline itself before this extraction. */
export function planProgress(entries: readonly AcpPlanEntry[]): PlanProgress {
  return {
    completed: entries.filter((entry) => entry.status === 'completed').length,
    total: entries.length,
  };
}

/** One plan entry tagged with its position in the wholesale-replaced `entries` array it came from — `PlanGroups`' own per-status arrays keep this rather than a bare `AcpPlanEntry`, since a grouped-by-status renderer needs a stable per-entry key that survives a plan update leaving this entry's group (and therefore its position within any single group's own list) unchanged. Mirrors `PlanCard.svelte`'s existing `{#each entries as entry, index (index)}` key exactly, so an entry that hasn't moved between two `plan_update`s (the common mid-turn case: one entry's status changes, the rest don't) keeps the same Svelte-tracked identity in both renderers. */
export interface KeyedPlanEntry {
  readonly entry: AcpPlanEntry;
  readonly key: number;
}

export interface PlanGroups {
  readonly pending: readonly KeyedPlanEntry[];
  readonly inProgress: readonly KeyedPlanEntry[];
  readonly completed: readonly KeyedPlanEntry[];
}

/**
 * Buckets `entries` by status, preserving each entry's original index (its
 * `plan_update`-order position) as the entry's key rather than a fresh
 * per-group index — see `KeyedPlanEntry`'s own doc comment for why. Order
 * within each bucket is preserved from `entries` (ACP never reorders a plan
 * client-side either); bucket iteration order is pending, in_progress,
 * completed, matching issue #201's own "grouped pending/in-progress/
 * completed" wording.
 */
export function groupPlanEntries(entries: readonly AcpPlanEntry[]): PlanGroups {
  const pending: KeyedPlanEntry[] = [];
  const inProgress: KeyedPlanEntry[] = [];
  const completed: KeyedPlanEntry[] = [];
  entries.forEach((entry, key) => {
    const keyed: KeyedPlanEntry = { entry, key };
    switch (entry.status) {
      case 'pending':
        pending.push(keyed);
        break;
      case 'in_progress':
        inProgress.push(keyed);
        break;
      case 'completed':
        completed.push(keyed);
        break;
    }
  });
  return { pending, inProgress, completed };
}
