<script lang="ts">
  /**
   * The session transcript, windowed (issue #755, SPEC.md §7.24 "keep item
   * ids stable across ticks so a virtualized transcript never remounts a
   * row mid-stream"). Replaces the old `+page.svelte` `{#each transcript
   * ?.items ?? [] as item}` loop, which mounted every item a session ever
   * received — fine for a short session, real cost on an hour-long one, on
   * a phone as much as a desktop (issue #755's own numbers). Only
   * `$lib/transcript/windowing.svelte.ts`'s computed `range` is ever
   * mounted, plus a small overscan; two spacer `<li>`s stand in for
   * whatever's hidden above/below (see that module's own doc comment for
   * why a spacer, not absolute positioning). `data-testid="transcript-row"`
   * on every real row, not the spacers, is what
   * `TranscriptTimeline.test.ts` counts.
   *
   * Owns everything the old inline block did: the scroll container itself,
   * the follow-the-bottom state (issue #508) and its "Jump to latest"
   * affordance, and the pin/anchor effect below — all internal now, since
   * nothing outside this component reads `followingTranscript` once the
   * jump button moved in with it. `sessionKey` (the caller's
   * `selectedSessionId`) is the one thing still driven from outside: a new
   * session is a different transcript, so it resets both the follow state
   * and every measured height back to a clean slate.
   *
   * Streaming pin-to-bottom (issue #755's first acceptance criterion): the
   * windowing engine's `pinToTail` guarantees the newest item is always
   * real DOM (never a spacer estimate) while following, so the effect
   * below can keep reading the browser's own, always-accurate
   * `scrollHeight` — the exact mechanism issue #508 shipped
   * (`el.scrollTop = el.scrollHeight`), just re-run on a measured-height
   * change too, not only a new `items` reference. Reading history (not
   * following) gets real anchoring instead: when a row above the rendered
   * window trades its estimate for a measured height, `range.leadPx`
   * moves, and the same effect nudges `scrollTop` by that exact delta so
   * whatever the reader is looking at doesn't jump under them.
   *
   * Accepted, narrower consequence of the same windowing (issue #755's
   * second acceptance criterion): native browser find (Ctrl/Cmd+F) can
   * only match rows currently mounted, not the whole transcript. This
   * component does nothing to restore THAT — but SPEC.md §7.19's own
   * in-app search (issues #262/#263) no longer has the same gap: it runs
   * against `$lib/transcript/search.ts`'s `searchTranscript` over the
   * FULL `items` array (never the DOM), and `searchQuery`/
   * `activeSearchItemId` below only paint whatever of those matches this
   * component currently has mounted — a match outside the window still
   * counts and is still reachable, via the exact same `jumpTarget`
   * mechanism `TranscriptJumpTarget` already documents below.
   */
  import {
    applyTranscriptSearchHighlights,
    clearTranscriptSearchHighlights,
  } from '$lib/transcript/search-highlight';
  import {
    computeToolCallNesting,
    type PendingPermissionRequest,
    type ToolCallNesting,
    type TranscriptItem,
    type TranscriptState,
  } from '@loombox/providers-core/browser';
  import { flushSync } from 'svelte';
  import { isThoughtStillThinking } from '$lib/thinking';
  import {
    isCompactToolRow,
    TranscriptWindow,
    type TranscriptWindowItem,
  } from '$lib/transcript/windowing.svelte';
  import Icon from './icons/Icon.svelte';
  import MessageItem from './MessageItem.svelte';
  import ToolCallRow from './ToolCallRow.svelte';
  import TranscriptGap from './TranscriptGap.svelte';

  /** A request to bring one specific item into the mounted window and scroll it into view (issue #740's turn-review "jump to this file's diff"), even when it's currently outside the range `windowing.svelte.ts` mounts. `token` must be bumped on every request, including a repeat click on an already-visible row's `id` — a bare `id` prop wouldn't re-trigger the `$effect` below on an unchanged value. */
  export interface TranscriptJumpTarget {
    id: string;
    token: number;
  }

  interface Props {
    /** Resets the window on change — see the doc comment above. Typically `+page.svelte`'s `selectedSessionId`. */
    sessionKey: string | undefined;
    items: readonly TranscriptItem[];
    transcript: TranscriptState | undefined;
    turnActive: boolean;
    providerId: string | undefined;
    permissionHead: PendingPermissionRequest | undefined;
    /** See {@link TranscriptJumpTarget}. `undefined` — the common case — does nothing. */
    jumpTarget: TranscriptJumpTarget | undefined;
    /** Fork the open session from a message row's own turn (design spec `2026-08-05-zed-parity-decisions.md` §3's C6-2; issue #746) — forwarded to `MessageItem`'s own `onFork`. Omitted renders no fork button on any row. */
    onFork?: (turnId: string) => void;
    /** The turn currently mid-fork, if any — forwarded to `MessageItem`'s own `forking` so only that turn's row shows the busy state. */
    forkingTurnId?: string;
    /** Opens a file in the canvas tab strip (issue #737's B2-2) — forwarded to `ToolCallRow`'s own `onOpenFile`, on down to whichever tool card actually renders a diff. Omitted renders no "Open" affordance on any diff card in this timeline. */
    onOpenFile?: (path: string) => void;
    /** The active search query (issues #262/#263), painted as CSS Custom Highlight API highlights over whatever mounted row currently has matching text — see `$lib/transcript/search-highlight.ts`'s own doc comment for why this never touches the row's actual DOM structure. `undefined`/empty clears every highlight this component owns. */
    searchQuery?: string;
    /** The item id of the search match the reader is currently navigated to, if any (`+page.svelte`'s active match) — painted with the stronger of the two named highlights. Meaningless without `searchQuery`. */
    activeSearchItemId?: string;
    /** Fires (issue #198's own reading-position capture) whenever the item at the TOP of the currently mounted window changes — the id of whatever the reader is currently looking at while detached from the live tail, `undefined` while pinned to it (following the tail has no fixed "current item", by design). Never fired for every scroll pixel; only on an actual top-item change. Omitted does nothing (no reading-position tracking is required of every caller — `+page.svelte` is the only one that currently cares). */
    onViewportItemChange?: (itemId: string | undefined) => void;
  }

  const {
    sessionKey,
    items,
    transcript,
    turnActive,
    providerId,
    permissionHead,
    jumpTarget,
    onFork,
    forkingTurnId,
    onOpenFile,
    searchQuery = '',
    activeSearchItemId,
    onViewportItemChange,
  }: Props = $props();

  /**
   * How far off the bottom still counts as "following" (issue #508). A
   * couple of lines of slack, because sub-pixel rounding and a growing
   * last item routinely leave `scrollTop` a hair short of the exact
   * bottom, and detaching on that would make the button flicker on every
   * streamed chunk.
   */
  const FOLLOW_TRANSCRIPT_SLACK_PX = 48;

  const win = new TranscriptWindow();
  let containerEl = $state<HTMLElement | undefined>(undefined);
  let following = $state(true);

  $effect(() => {
    win.items = items as readonly TranscriptWindowItem[];
  });

  $effect(() => {
    void sessionKey;
    win.reset();
    following = true;
    // A new session's rows haven't mounted yet — never let the outgoing
    // session's highlights flash over whatever the new one's transcript
    // draws first.
    clearTranscriptSearchHighlights();
  });

  $effect(() => {
    win.pinToTail = following;
  });

  const visibleItems = $derived(
    win.range.start >= 0 ? items.slice(win.range.start, win.range.end + 1) : [],
  );

  /**
   * Repaints transcript search highlights (issues #262/#263) on any
   * change to what this component actually has mounted (a new `items`
   * reference, a scroll that moves `win.range`, a just-measured row
   * trading its estimate for a real height) as well as on the query/
   * active-match themselves — reading `visibleItems` alone covers the
   * first three in one dependency, since it already recomputes from both
   * `items` and `win.range`. See `$lib/transcript/search-highlight.ts`'s
   * own doc comment for why this never reuses a character offset and
   * instead re-finds the query live against whatever text is really
   * mounted right now.
   */
  $effect(() => {
    void visibleItems;
    applyTranscriptSearchHighlights(containerEl, searchQuery, activeSearchItemId);
  });

  /** Never leaves a stale highlight painted once this component itself unmounts (e.g. the canvas switches away from the transcript tab entirely) — mirrors `MessageItem.svelte`'s own mount-once/cleanup-on-unmount `$effect` shape. */
  $effect(() => {
    return () => clearTranscriptSearchHighlights();
  });

  /**
   * Subagent/nested-tool-call tree rendering (issue #200; SPEC.md §7.24).
   * Computed ONCE per `items` reference from the FULL transcript, never
   * from `visibleItems` — a windowed transcript (#755) can easily mount a
   * child without its parent's own row also being mounted (they can be far
   * apart in a long session), and this must still resolve the same nesting
   * either way. Each mounted tool-call row below does an O(1) `.get(item.id)`
   * against this map rather than re-walking its own chain.
   */
  const toolCallNesting = $derived(computeToolCallNesting(items));

  /**
   * Visual indent is capped, unlike the real (unbounded) `depth` this reads
   * from `toolCallNesting` — a genuinely deep chain (issue #200's "depth
   * greater than two" acceptance bullet) still needs SOME defined behavior
   * rather than the row shrinking toward zero width; capping the padding
   * while leaving `depth` itself uncapped is that behavior. The "nested in
   * …" caption always names the IMMEDIATE parent regardless of overall
   * depth, so a reader never loses that context even once the indent stops
   * growing.
   */
  const MAX_NESTING_INDENT = 3;

  function nesting(item: TranscriptItem): ToolCallNesting | undefined {
    return item.type === 'tool_call' ? toolCallNesting.get(item.id) : undefined;
  }

  function distanceFromBottom(el: HTMLElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }

  function onScroll(event: Event): void {
    const el = event.currentTarget as HTMLElement;
    win.scrollTop = el.scrollTop;
    following = distanceFromBottom(el) <= FOLLOW_TRANSCRIPT_SLACK_PX;
  }

  function jumpToLatest(): void {
    following = true;
    // `following` flipping true only mounts the tail (and thus grows the
    // real `scrollHeight`) once the effect below actually runs — flush it
    // synchronously first, or the `scrollTo` below targets the OLD,
    // pre-tail `scrollHeight` (issue #755: unlike the pre-windowing
    // version, the tail is not guaranteed to already be mounted here).
    flushSync();
    const el = containerEl;
    if (!el) return;
    // jsdom (component tests) has no `Element.scrollTo` — same guard
    // family as `measureContainer`/`measureRow` below.
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }

  /** CSS attribute-selector escaping for `jumpItemEl` below — only `"` and `\` are meaningful inside a quoted attribute value; a transcript item id is agent/client-generated and has no other reason to be escaped. */
  function escapeAttributeValue(value: string): string {
    return value.replace(/["\\]/g, '\\$&');
  }

  function jumpItemEl(id: string): HTMLElement | null {
    return (
      containerEl?.querySelector<HTMLElement>(`[data-item-id="${escapeAttributeValue(id)}"]`) ??
      null
    );
  }

  /**
   * Handles a `jumpTarget` request (issue #740's turn-review "jump to this
   * file's diff"). `id` is very likely NOT currently mounted — that's the
   * whole reason this exists rather than a caller just calling
   * `scrollIntoView` itself — so this is a three-step version of
   * `jumpToLatest` above: detach from following, force the window to
   * include the target row (`TranscriptWindow.focusIndex`, which only
   * needs the row's INDEX, not its real DOM), flush so that row actually
   * mounts, then scroll the now-real element into view. A target id this
   * transcript doesn't contain (a stale click racing a session switch) is
   * silently ignored, same as `win.focusIndex`'s own out-of-range guard.
   */
  $effect(() => {
    const target = jumpTarget;
    if (!target) return;
    const index = items.findIndex((item) => item.id === target.id);
    if (index === -1) return;
    following = false;
    win.focusIndex(index);
    flushSync();
    const rowEl = jumpItemEl(target.id);
    if (typeof rowEl?.scrollIntoView === 'function') {
      rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  /** Both initialized from the first effect run, before either branch below could compare against a stale/mismatched window. */
  let previousLeadPx = win.range.leadPx;
  let previousScrollInput = win.scrollTop;

  $effect(() => {
    // Reactive dependencies: `win.range` changes on a new item, a
    // container resize, a scroll, or a just-measured row's real height
    // replacing its estimate — see the doc comment above for why both
    // branches below need every one of those.
    const range = win.range;
    const isFollowing = following;
    const scrollInput = win.scrollTop;
    const el = containerEl;
    if (!el) return;
    if (isFollowing) {
      el.scrollTop = el.scrollHeight;
    } else if (scrollInput === previousScrollInput && range.leadPx !== previousLeadPx) {
      // `scrollInput === previousScrollInput` is the guard: `onScroll`
      // always updates `win.scrollTop` from the real DOM in the same tick
      // a user's scroll (or a follow→detach transition) happens, so an
      // UNCHANGED `win.scrollTop` alongside a CHANGED `range.leadPx` can
      // only mean a row above the window just traded its estimate for a
      // real measured height while the reader stayed put — the one case
      // this compensates for. A `win.scrollTop` change (the reader
      // scrolling, or just detaching) already moved the real viewport
      // exactly where they put it; adding a delta on top of THAT would
      // fight their own scroll.
      el.scrollTop += range.leadPx - previousLeadPx;
    }
    previousLeadPx = range.leadPx;
    previousScrollInput = scrollInput;
  });

  /**
   * Reports the item at the top of the currently mounted window (issue
   * #198's own reading-position capture) — `undefined` while `following`
   * (pinned to the live tail has no fixed "current item"; a caller
   * restoring a saved position later should land back at the tail, the
   * same default a session with no saved position has always had).
   * `win.range.start` indexes into the FULL `items` array (not the
   * windowed `visibleItems` slice), same convention `jumpTarget`'s own
   * effect above uses. Guarded on an actual id change, not `win.range`
   * itself — `win.range` recomputes on every sub-pixel scroll tick and
   * `$effect` already dedupes a same-value dependency read, but the
   * explicit guard keeps this reads-as-a-callback contract obvious rather
   * than relying on that.
   */
  let previousViewportItemId: string | undefined;
  let hasReportedViewportItem = false;
  $effect(() => {
    const topItemId = following ? undefined : items[win.range.start]?.id;
    if (hasReportedViewportItem && topItemId === previousViewportItemId) return;
    hasReportedViewportItem = true;
    previousViewportItemId = topItemId;
    onViewportItemChange?.(topItemId);
  });

  function measureContainer(node: HTMLElement): { destroy(): void } {
    win.viewportPx = node.clientHeight;
    // jsdom (component tests) has no `ResizeObserver` — the same guard
    // `InteractiveTerminal.svelte` uses for the same reason. The one
    // synchronous read above still covers a real browser's first paint,
    // since a `ResizeObserver` callback never fires before that.
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        win.viewportPx = node.clientHeight;
      });
      observer.observe(node);
    }
    return {
      destroy() {
        observer?.disconnect();
      },
    };
  }

  function measureRow(
    node: HTMLElement,
    id: string,
  ): { update(next: string): void; destroy(): void } {
    let currentId = id;
    const measure = () => win.recordHeight(currentId, node.getBoundingClientRect().height);
    measure();
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure);
      observer.observe(node);
    }
    return {
      update(next: string) {
        currentId = next;
        measure();
      },
      destroy() {
        observer?.disconnect();
      },
    };
  }
</script>

<ol
  class="items"
  bind:this={containerEl}
  use:measureContainer
  onscroll={onScroll}
  data-testid="transcript-items"
>
  {#if win.range.start > 0}
    <li class="items-spacer" aria-hidden="true" style={`height: ${win.range.leadPx}px`}></li>
  {/if}
  {#each visibleItems as item, offset (item.id)}
    {@const itemIndex = win.range.start + offset}
    {@const itemNesting = nesting(item)}
    <li
      use:measureRow={item.id}
      class:tool-call-compact={isCompactToolRow(
        items as readonly TranscriptWindowItem[],
        itemIndex,
      )}
      class:tool-call-nested={itemNesting !== undefined && itemNesting.depth > 0}
      data-testid="transcript-row"
      data-item-id={item.id}
      data-nesting-depth={itemNesting?.depth}
      style={itemNesting && itemNesting.depth > 0
        ? `padding-left: calc(var(--space-lg) * ${Math.min(itemNesting.depth, MAX_NESTING_INDENT)})`
        : undefined}
    >
      {#if item.type === 'message'}
        <MessageItem
          {item}
          thinking={item.kind === 'agent_thought_chunk' && transcript
            ? isThoughtStillThinking(transcript, item.turnId)
            : false}
          {turnActive}
          {providerId}
          {onFork}
          forking={forkingTurnId === item.turnId}
        />
      {:else if item.type === 'gap'}
        <TranscriptGap {item} />
      {:else}
        {#if itemNesting && itemNesting.depth > 0}
          <div class="nesting-label" data-testid="tool-call-nesting-label">
            <span class="nesting-connector" aria-hidden="true"></span>
            <span>nested in {itemNesting.parentTitle ?? 'a subagent call'}</span>
          </div>
        {/if}
        <ToolCallRow
          {item}
          awaitingPermission={permissionHead !== undefined &&
            permissionHead.toolCall.id === item.id}
          {onOpenFile}
        />
      {/if}
    </li>
  {/each}
  {#if win.range.end >= 0 && win.range.end < items.length - 1}
    <li class="items-spacer" aria-hidden="true" style={`height: ${win.range.tailPx}px`}></li>
  {/if}
</ol>

{#if !following}
  <button
    type="button"
    class="jump-latest"
    onclick={jumpToLatest}
    data-testid="transcript-jump-latest"
  >
    <Icon name="chevron-down" size="100%" />
    Jump to latest
  </button>
{/if}

<style>
  /* A readable measure (spec §3.4 / defect C3): transcript prose used to
     run the full 1440-1920px canvas, ~150 characters a line. Code, diffs
     and terminal output opt into `--measure-wide` from their own
     components. */
  .items {
    flex: 1;
    width: 100%;
    max-width: var(--measure);
    margin-inline: auto;
    overflow-y: auto;
    list-style: none;
    padding: 0;
    margin-block: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  /* Pure layout, never real content — kept out of assistive tech and
     (like every unmounted row) out of native browser find; see this
     file's own doc comment for why that's an accepted consequence rather
     than a bug here.

     `flex-shrink: 0` is load-bearing, not decoration (issue #755's own
     Playwright regression: a detached reader's `scrollHeight` silently
     stopped growing as new tail content streamed in). `.items` is itself
     height-constrained (`flex: 1` inside `.canvas`), and every `<li>`'s
     flex-shrink defaults to 1 — a real row resists shrinking because its
     rendered content has a non-trivial min-content floor, but an empty
     spacer has none, so the flex algorithm was squeezing THIS element's
     explicit `height` down to whatever slack remained instead of letting
     `.items` genuinely overflow, capping `scrollHeight` at `clientHeight`
     regardless of how tall the windowing engine's own `leadPx`/`tailPx`
     said it should be. */
  .items-spacer {
    list-style: none;
    flex-shrink: 0;
  }

  /* C3-2 (v7 decisions §3, issue #668): consecutive tool calls read as one
     compact list, not N separately-spaced turns — this `<li>` sits
     directly under another tool-call `<li>` (see `isCompactToolRow`,
     shared with the windowing engine's own spacer sizing so a hidden
     predecessor still produces the right gap), so it pulls up against
     `.items`' own `--space-sm` flex gap, leaving a tight `--space-3xs`
     list rhythm instead. The first call in a run (or a lone one) keeps
     the full gap, same as any other turn boundary. */
  .items li.tool-call-compact {
    margin-top: calc(var(--space-3xs) - var(--space-sm));
  }

  /*
   * Subagent/nested-tool-call tree rendering (issue #200; SPEC.md §7.24).
   * Purely a visual affordance on the ROW WRAPPER — `ToolCallRow`'s own
   * markup/CSS is completely untouched, so a nested call renders through
   * its normal tier-1/2 widget with an unchanged row shape, just indented
   * (issue #200's acceptance). The indent itself is set inline per-`<li>`
   * (`padding-left: calc(var(--space-lg) * <capped depth>)`, see
   * `MAX_NESTING_INDENT`) rather than through a bespoke custom property
   * here — `styles/tokens.test.ts`'s hygiene check requires every `var()`
   * reference to resolve to a real, globally-defined token, and a per-row
   * computed depth is not one. Depth is computed from the FULL transcript,
   * not from what's currently mounted, so this never depends on the
   * parent row also being mounted (see `toolCallNesting`'s own doc
   * comment). The border, unlike the indent, is a plain static rule.
   */
  .items li.tool-call-nested {
    border-left: 2px solid var(--color-border-subtle);
  }

  .nesting-label {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    margin: 0 0 var(--space-3xs);
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }

  .nesting-connector {
    flex-shrink: 0;
    width: 0.7em;
    height: 0.7em;
    border-left: 2px solid var(--color-border);
    border-bottom: 2px solid var(--color-border);
    border-radius: 0 0 0 3px;
  }

  /* The "there is more below" affordance #508 asked for. Sits between the
     scrolling transcript and the pinned footer, so it reads as the edge of
     the scroll region rather than as another transcript item, and it exists
     only while detached — a permanent control here would be one more thing
     to ignore. */
  .jump-latest {
    align-self: center;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    margin-top: calc(var(--space-sm) * -1);
    padding: var(--space-2xs) var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-sm);
    color: var(--color-text-secondary);
    font-size: var(--text-caption-size);
    cursor: pointer;
  }

  .jump-latest :global(svg) {
    width: 0.85em;
    height: 0.85em;
  }

  .jump-latest:hover {
    color: var(--color-text-primary);
    border-color: var(--color-border-strong);
  }
</style>
