import { SvelteMap } from 'svelte/reactivity';

/**
 * Real transcript windowing (issue #755, SPEC.md §7.24's own "keep item ids
 * stable across ticks so a virtualized transcript never remounts a row
 * mid-stream" clause). Mounts only the rows a reader could plausibly see
 * (plus a small overscan), never the whole history, and computes their
 * geometry itself since a tool row and a 400px diff have wildly different,
 * unknown-until-measured heights (a fixed-height virtualizer is wrong
 * here).
 *
 * This is a hand-rolled offsets/binary-search engine, not
 * `@tanstack/virtual-core` or similar — see this repo's PR for #755 for the
 * full justification; in short, the crux of this issue is a bespoke
 * anchoring contract (pin-to-bottom while streaming, no jump while reading
 * history) that any general-purpose virtualizer still needs hand-written
 * glue for, and owning the ~120 lines of offset math here keeps that glue
 * (and its tests) working against plain numbers instead of a third party's
 * ResizeObserver/rect-observation internals.
 *
 * Rendering strategy: a "lead" and "tail" spacer `<li>` stand in for every
 * hidden row (see `TranscriptTimeline.svelte`), sized from this class's
 * `range.leadPx`/`range.tailPx` — NOT absolute positioning. That choice
 * keeps every existing `.items` flex/gap rule (including the tool-call
 * "compact" rhythm below) working unmodified for whichever rows are
 * actually mounted.
 */

export interface TranscriptWindowItem {
  readonly id: string;
  readonly type: string;
}

/** tokens.css `--space-sm` (0.5rem @ the app's 16px root) — the `.items` flex `gap` every adjacent row pair gets by default. Kept as a literal, not read live via `getComputedStyle`, since it only ever needs to match a spacer's estimate, not render a pixel-perfect box — see the module doc comment. */
export const TRANSCRIPT_ROW_GAP_PX = 8;

/** tokens.css `--space-3xs` (0.125rem) — the tightened rhythm between two consecutive `tool_call` rows (`.items li.tool-call-compact`'s `margin-top: calc(var(--space-3xs) - var(--space-sm))`, which nets out to exactly this against the base gap above). */
export const TRANSCRIPT_COMPACT_GAP_PX = 2;

/** Stand-in height for a row that has never been mounted/measured. Most transcript rows are short tool rows or a couple of prose lines; a 400px diff is the outlier, not the average, so this errs toward the common case rather than the extreme. Only ever used until the real row mounts once and reports its true height — never round-tripped back into layout after that. */
export const TRANSCRIPT_ROW_ESTIMATE_PX = 56;

/** Extra rows kept mounted beyond the computed visible span, each side, so a fast scroll or a just-resized row doesn't flash an empty gap for one frame before the next measurement lands. */
export const TRANSCRIPT_OVERSCAN_ITEMS = 6;

/** Minimum rows kept mounted from the tail while `pinToTail` is set and the container hasn't reported a real `clientHeight` yet (first paint, or a hidden/zero-size container) — see `range`'s doc comment for why pin mode can't simply fall back to `scrollTop`-driven math in that case. */
const TRANSCRIPT_MIN_PINNED_ITEMS = 20;

/**
 * True when `items[index]` is a `tool_call` directly following another
 * `tool_call` (SPEC.md §7.24 / C3-2, issue #668's "consecutive tool calls
 * read as one compact list"). The single source of truth for that rule:
 * both the offsets engine below (spacer sizing) and `TranscriptTimeline`'s
 * `class:tool-call-compact` binding on the real, rendered `<li>` call this
 * — so a hidden predecessor still produces the right gap the instant its
 * successor scrolls into view.
 */
export function isCompactToolRow(items: readonly TranscriptWindowItem[], index: number): boolean {
  return items[index]?.type === 'tool_call' && items[index - 1]?.type === 'tool_call';
}

/** first index in `[lo, hi)` whose value is `>= target`, or `hi` if none. `offsets` must be non-decreasing. */
function lowerBound(offsets: readonly number[], target: number, lo: number, hi: number): number {
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

export interface TranscriptRange {
  /** first rendered index, inclusive; -1 when there are no items at all. */
  start: number;
  /** last rendered index, inclusive; -1 when there are no items at all. */
  end: number;
  /** px height standing in for every hidden item before `start`. */
  leadPx: number;
  /** px height standing in for every hidden item after `end`. */
  tailPx: number;
}

const EMPTY_RANGE: TranscriptRange = { start: -1, end: -1, leadPx: 0, tailPx: 0 };

/**
 * Owns the transcript's measured/estimated row heights and derives which
 * rows to mount. Every public field/getter here is Svelte-reactive:
 * `svelte/reactivity`'s `SvelteMap` makes a plain `heights.set(...)` a
 * tracked write, so reading `.range` inside a template or another
 * `$derived` recomputes automatically off `.items`, `.scrollTop`,
 * `.viewportPx`, `.pinToTail`, and any `recordHeight()` call — no manual
 * version counter needed.
 */
export class TranscriptWindow {
  readonly #heights = new SvelteMap<string, number>();

  items: readonly TranscriptWindowItem[] = $state.raw([]);
  scrollTop = $state(0);
  viewportPx = $state(0);
  /**
   * Forces the render range's `end` to the very last item, computed
   * backward from the tail rather than from `scrollTop` (issue #755's
   * follow-mode contract): the item currently streaming must always be
   * real DOM, never a spacer estimate, or there is nothing accurate for
   * `TranscriptTimeline`'s pin effect to read `scrollHeight` off. Deriving
   * it from the tail rather than from `scrollTop` also sidesteps the
   * chicken-and-egg case where `scrollTop`/`viewportPx` haven't been
   * reported yet (first paint of a freshly-opened long session).
   */
  pinToTail = $state(true);

  readonly #offsets = $derived.by((): number[] => {
    const items = this.items;
    const offsets = new Array<number>(items.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < items.length; i += 1) {
      const height = this.#heights.get(items[i].id) ?? TRANSCRIPT_ROW_ESTIMATE_PX;
      const gapPx =
        i === 0
          ? 0
          : isCompactToolRow(items, i)
            ? TRANSCRIPT_COMPACT_GAP_PX
            : TRANSCRIPT_ROW_GAP_PX;
      offsets[i + 1] = offsets[i] + gapPx + height;
    }
    return offsets;
  });

  /** Sum of every row's current (measured-or-estimated) height, gaps included — what `.items`' real `scrollHeight` converges toward as rows get measured. */
  readonly totalPx = $derived(this.#offsets.at(-1) ?? 0);

  readonly range: TranscriptRange = $derived.by((): TranscriptRange => {
    const items = this.items;
    const offsets = this.#offsets;
    const n = items.length;
    if (n === 0) return EMPTY_RANGE;

    let start: number;
    let end: number;

    if (this.pinToTail) {
      end = n - 1;
      const minSpanPx =
        this.viewportPx > 0
          ? this.viewportPx
          : TRANSCRIPT_ROW_ESTIMATE_PX * TRANSCRIPT_MIN_PINNED_ITEMS;
      let idx = n - 1;
      while (idx > 0 && offsets[n] - offsets[idx] < minSpanPx) idx -= 1;
      start = idx;
    } else {
      const viewTop = this.scrollTop;
      const viewBottom = this.scrollTop + this.viewportPx;
      start = Math.max(0, lowerBound(offsets, viewTop, 1, n) - 1);
      end = Math.min(n - 1, Math.max(start, lowerBound(offsets, viewBottom, start, n) - 1));
    }

    start = Math.max(0, start - TRANSCRIPT_OVERSCAN_ITEMS);
    end = Math.min(n - 1, end + TRANSCRIPT_OVERSCAN_ITEMS);

    return {
      start,
      end,
      leadPx: offsets[start],
      // The one bounded inaccuracy in this model: this includes the gap
      // between item[end] and item[end + 1] (if any), which the real flex
      // `gap` between item[end]'s `<li>` and the tail spacer also
      // supplies — at most one row's worth of double-counted gap
      // (<=8px), never compounding, and irrelevant to both the 48px
      // follow-slack threshold and the lead-side anchor math below.
      tailPx: this.totalPx - offsets[end + 1],
    };
  });

  /** Records a row's real measured height. Ignores a non-positive reading (an element that hasn't actually laid out yet — e.g. `display:none`, or jsdom, which never runs layout at all) rather than corrupting the map with it. */
  recordHeight(id: string, height: number): void {
    if (!(height > 0)) return;
    if (this.#heights.get(id) === height) return;
    this.#heights.set(id, height);
  }

  /** Drops every measured height (issue #755: a session switch is a different transcript, and unbounded retention across an entire day of switching sessions costs real memory for no benefit — a freshly re-opened session re-measures its own rows in a frame or two anyway). */
  reset(): void {
    this.#heights.clear();
  }
}
