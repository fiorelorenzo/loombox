/**
 * The DOM-facing half of transcript search (SPEC.md §7.19; issues
 * #262/#263: "highlighting uses the CSS Custom Highlight API, not manual
 * DOM text-node wrapping"). `./search.ts` finds WHICH items match, over
 * the full, always-decrypted `TranscriptState.items` array; this module
 * only paints highlights onto whatever a currently mounted transcript
 * row's rendered DOM happens to contain.
 *
 * Deliberately decoupled from `search.ts`'s own match data (which carries
 * no character offset at all): a message's `item.text` is raw Markdown
 * source, and `MessageItem.svelte` renders it through a full remark/rehype
 * pipeline (`$lib/markdown.ts`) that strips syntax and reflows the text
 * across an arbitrary number of inline elements — a `**bold**` run's
 * rendered text has no asterisks left and lives in its own child
 * `<strong>` text node. An offset computed against the raw Markdown source
 * cannot be replayed against the rendered DOM without re-implementing
 * that whole pipeline's own text layout. Instead, {@link findTextRanges}
 * walks whatever text nodes a mounted row actually has right now and
 * finds the query independently, live, against their own `textContent` —
 * exactly correct for what is really on screen, and far simpler than
 * offset translation.
 *
 * Native browser find has the identical constraint, already documented on
 * `TranscriptTimeline.svelte`'s own top doc comment ("native browser find
 * ... can only match rows currently mounted"): a row with no mounted DOM
 * (windowed out — issue #755 — or a still-collapsed thought body,
 * `$lib/expand-thoughts.ts`) has no text nodes to search, so it paints no
 * highlight until it mounts. `./search.ts`'s own match list is what keeps
 * that from ever blocking navigation: `+page.svelte` forces the target
 * row into the window first (the same `TranscriptJumpTarget` mechanism
 * issue #740 shipped), and only then does this module have anything to
 * find and highlight. A match inside a thought whose body is still
 * collapsed is a documented, narrower case of the same thing: the row
 * mounts and scrolls into view, but the thought's own independent
 * expand/collapse state (owned entirely by `MessageItem.svelte`, with no
 * external override today) is untouched, so that specific occurrence has
 * nothing to highlight until the reader expands it by hand.
 */

/** `CSS.highlights` registry key for every match currently visible in a mounted row. Styled in `$lib/styles/deck.css` via `::highlight()` — see that rule's own doc comment for why it can't live in this component's scoped styles. */
export const TRANSCRIPT_SEARCH_HIGHLIGHT = 'loombox-transcript-search';

/** Registry key for the one match the reader is currently navigated to (`+page.svelte`'s active index) — painted with a stronger color than the plain match set above. */
export const TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT = 'loombox-transcript-search-active';

const TRANSCRIPT_ROW_SELECTOR = '[data-testid="transcript-row"]';

/**
 * Every `Range` inside `root` whose text matches `query` (case-insensitive
 * substring, same semantics as `search.ts`'s own `searchTranscript`),
 * found by walking `root`'s live text nodes — see the file doc comment for
 * why this never reuses an offset computed elsewhere. Exported standalone
 * so a test can exercise the matching logic without a real `CSS.
 * highlights` global (jsdom has no such thing, but does implement
 * `TreeWalker`/`Range` well enough for this).
 */
export function findTextRanges(root: Node, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? '';
    const lower = text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      from = at + needle.length;
    }
    node = walker.nextNode();
  }
  return ranges;
}

/**
 * Repaints both named highlights from scratch against `container`'s
 * currently mounted transcript rows. Cheap enough to call on every
 * keystroke, scroll, or window change: a real transcript's mounted range
 * is capped at a couple dozen rows plus overscan (issue #755's own
 * windowing budget — `TRANSCRIPT_OVERSCAN_ITEMS`), never the whole
 * session, so this always walks a small, bounded slice of the DOM.
 *
 * `query.trim() === ''`, no `container`, or no CSS Custom Highlight
 * support all clear/no-op — a caller never needs its own guard for any of
 * the three.
 */
export function applyTranscriptSearchHighlights(
  container: HTMLElement | undefined,
  query: string,
  activeItemId: string | undefined,
): void {
  if (typeof CSS === 'undefined' || typeof CSS.highlights === 'undefined') return;
  const registry = CSS.highlights;
  if (!container || query.trim() === '') {
    registry.delete(TRANSCRIPT_SEARCH_HIGHLIGHT);
    registry.delete(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT);
    return;
  }

  const allRanges: Range[] = [];
  const activeRanges: Range[] = [];
  container.querySelectorAll<HTMLElement>(TRANSCRIPT_ROW_SELECTOR).forEach((row) => {
    const ranges = findTextRanges(row, query);
    allRanges.push(...ranges);
    if (row.dataset.itemId === activeItemId) activeRanges.push(...ranges);
  });

  if (allRanges.length === 0) registry.delete(TRANSCRIPT_SEARCH_HIGHLIGHT);
  else registry.set(TRANSCRIPT_SEARCH_HIGHLIGHT, new Highlight(...allRanges));

  if (activeRanges.length === 0) registry.delete(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT);
  else registry.set(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT, new Highlight(...activeRanges));
}

/** Clears both highlights unconditionally — `TranscriptTimeline.svelte`'s own unmount/session-switch cleanup, so a highlight never survives into a session (or a route) that never asked for it. */
export function clearTranscriptSearchHighlights(): void {
  if (typeof CSS === 'undefined' || typeof CSS.highlights === 'undefined') return;
  CSS.highlights.delete(TRANSCRIPT_SEARCH_HIGHLIGHT);
  CSS.highlights.delete(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT);
}
