import type {
  ToolCallNesting,
  TranscriptItem,
  TranscriptToolCallItem,
} from '@loombox/providers-core/browser';

/**
 * The tier-3 tool-call burst/group summary card (issue #202; SPEC.md §7.24's
 * own tier-3 bullet, alongside the tier-1 bespoke widget table and the
 * tier-2 generic `ToolKind` fallback). Runs BEFORE `TranscriptTimeline`'s
 * windowing (`$lib/transcript/windowing.svelte.ts`, issue #755), not after
 * — {@link groupToolCallBursts} folds a long run of sibling tool calls into
 * ONE synthetic {@link ToolCallBurstGroupItem} in the array the window
 * actually mounts from, so a group is always an atomic windowed item, the
 * same as a `message` or a lone `tool_call`. That ordering is what makes
 * "a group spanning the window boundary must not half-render" true by
 * construction rather than by a special case: the window's `[start, end]`
 * range is computed over THIS array, so it can only ever include or exclude
 * a group whole, never slice through the middle of its own real calls.
 *
 * The grouping rule (design review `docs/design/ux-review-2026-08-04/
 * section-c-toolcalls.html` §C3, "a burst of five to fifteen calls in one
 * turn", option C3-3 "a summary row that expands" — brought forward from
 * review into this ticket's own concrete implementation): a run of MORE
 * THAN {@link TOOL_CALL_BURST_THRESHOLD} consecutive `tool_call` items that
 * share the same nesting scope collapses into one card. "Same nesting
 * scope" reads `nesting` (computed once per full transcript by
 * `computeToolCallNesting`, issue #200) rather than the item's own raw
 * `parentToolCallId` field directly, so an ORPHAN child (a `parentToolCallId`
 * that never resolved — #200's own "still renders, at the top level" rule)
 * groups with genuine root-level calls exactly as it renders alongside
 * them, instead of being excluded by a dangling id nobody can see. This is
 * deliberately uniform across depth: a flat run of root-level calls and one
 * subagent's own run of nested children both group the same way, since both
 * are "a burst" from a reader's point of view — the issue's own body names
 * "large tool-call bursts AND subagent groups" as the same problem.
 * "Consecutive" means literally adjacent in `items`, nothing else between
 * (not even a message) — the same discipline `windowing.svelte.ts`'s own
 * `isCompactToolRow` already uses for the visual "compact" rhythm a run of
 * tool calls gets; a message interrupting a run is a real break in the
 * reader's story, not a burst continuing.
 *
 * Streaming stability (this ticket's own hard requirement: "a group that
 * re-forms differently on every update will flicker, which is worse than
 * no grouping"): {@link groupToolCallBursts} is a pure function of the
 * FULL, growing `items` array — recomputed from scratch on every call, like
 * `computeToolCallNesting` — but grouping is prefix-stable by construction.
 * A run's membership is decided only by what has already streamed in, never
 * by what comes later, so a run already closed by a scope change or a
 * non-tool_call item can never reopen or change shape once more items
 * arrive after it. A still-open run at the tail (the common case: the burst
 * IS what's currently streaming) keeps the identical group `id` —
 * `tool_call_group::<first call's id>` — on every recompute for as long as
 * that same first call anchors it, so Svelte's keyed `{#each}` in
 * `TranscriptTimeline.svelte` never remounts the row, only grows its
 * `calls`. The one intentional, one-time visual change is the threshold
 * crossing itself (four individual rows becoming one card the instant a
 * fifth+sixth arrives) — a deliberate collapse, not the per-tick
 * reshuffling this requirement rules out.
 */
export const TOOL_CALL_BURST_THRESHOLD = 5;

/**
 * The tier-3 summary card's own synthetic transcript item — never produced
 * by the reducer (`packages/providers/core/src/transcript.ts`), only by
 * {@link groupToolCallBursts} downstream of it, in the UI layer alone. `id`
 * is namespaced (`tool_call_group::…`) so it can never collide with a real
 * agent-issued tool-call id, and stays fixed to the run's first call for as
 * long as that run keeps growing (see the module doc comment on why that's
 * what keeps a live-streaming group from flickering).
 */
export interface ToolCallBurstGroupItem {
  type: 'tool_call_group';
  id: string;
  /** Every call this group currently collapses, in transcript order — real `TranscriptToolCallItem`s, not ids, so `ToolCallBurstGroup.svelte`'s expanded detail can hand them straight to `ToolCallRow` with no second lookup. */
  calls: readonly TranscriptToolCallItem[];
  /** The nesting depth every member call shares (see the module doc comment's "same nesting scope" rule) — mirrors `ToolCallNesting.depth`, `0` for a root-level burst. */
  depth: number;
  /** The shared immediate parent's own title, set only when `depth > 0` — mirrors `ToolCallNesting.parentTitle`. */
  parentTitle: string | undefined;
}

/** What `TranscriptTimeline.svelte` actually mounts, one entry per windowed row: every real transcript item type, plus the tier-3 burst group this module introduces. */
export type TranscriptDisplayItem = TranscriptItem | ToolCallBurstGroupItem;

/**
 * Folds `items` into what `TranscriptTimeline.svelte` actually mounts —
 * see the module doc comment for the full grouping rule and its streaming-
 * stability argument. `nesting` is `computeToolCallNesting(items)`, passed
 * in rather than recomputed here: the caller already owns one pass over the
 * full transcript for issue #200's own nesting/indent rendering, and this
 * reuses it rather than walking `items` a second time for the same answer.
 */
export function groupToolCallBursts(
  items: readonly TranscriptItem[],
  nesting: ReadonlyMap<string, ToolCallNesting>,
): TranscriptDisplayItem[] {
  const result: TranscriptDisplayItem[] = [];
  let pending: TranscriptToolCallItem[] = [];
  let pendingScope: string | undefined;

  const flush = (): void => {
    if (pending.length === 0) return;
    if (pending.length > TOOL_CALL_BURST_THRESHOLD) {
      const first = pending[0]!;
      const firstNesting = nesting.get(first.id);
      result.push({
        type: 'tool_call_group',
        id: `tool_call_group::${first.id}`,
        calls: pending,
        depth: firstNesting?.depth ?? 0,
        parentTitle: firstNesting?.parentTitle,
      });
    } else {
      result.push(...pending);
    }
    pending = [];
    pendingScope = undefined;
  };

  for (const item of items) {
    if (item.type !== 'tool_call') {
      flush();
      result.push(item);
      continue;
    }
    // A tool call's grouping scope: `undefined` for a root-level call (real
    // or orphaned — see the module doc comment's "ORPHAN child" note),
    // otherwise its immediate resolved parent's own id. Two calls can only
    // share a burst group when this value matches exactly.
    const itemNesting = nesting.get(item.id);
    const scope = (itemNesting?.depth ?? 0) > 0 ? item.parentToolCallId : undefined;
    if (pending.length > 0 && scope !== pendingScope) flush();
    pending.push(item);
    pendingScope = scope;
  }
  flush();

  return result;
}

/**
 * Resolves a raw transcript item id (a `TranscriptJumpTarget.id` — issue
 * #740's "jump to this file's diff", or issue #262/#263's off-window search
 * match) to its index in `displayItems`: the item's own index when it
 * renders standalone, or its enclosing burst group's index when
 * {@link groupToolCallBursts} folded it in. `-1` for an id this transcript
 * never produced (a stale click racing a session switch), same contract as
 * `Array.prototype.findIndex` itself.
 */
export function findDisplayIndexForItemId(
  displayItems: readonly TranscriptDisplayItem[],
  id: string,
): number {
  return displayItems.findIndex(
    (item) =>
      item.id === id ||
      (item.type === 'tool_call_group' && item.calls.some((call) => call.id === id)),
  );
}
