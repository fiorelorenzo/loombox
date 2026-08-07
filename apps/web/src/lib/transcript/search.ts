import type { TranscriptItem } from '@loombox/providers-core/browser';

/**
 * Client-side transcript search (SPEC.md §7.19; issues #262/#263). Runs
 * against `TranscriptState.items` directly — the reducer's own, always-
 * fully-decrypted array (the relay never sees plaintext at all, §8; the
 * client's crypto worker, `$lib/crypto-worker-engine.ts`, decrypts every
 * envelope as it streams in, well before anything is windowed) — never
 * against the DOM.
 *
 * This is the deliberate fix for the gap a naive search would have: issue
 * #755's windowing (`$lib/transcript/windowing.svelte.ts`,
 * `TranscriptTimeline.svelte`) mounts only a scrollable slice of `items`
 * as real rows, exactly like a browser's own Ctrl/Cmd+F would see — that
 * component's own top doc comment calls this out by name ("native browser
 * find can only match rows currently mounted... in-app search... is
 * designed against the reducer's event model rather than the DOM for
 * exactly this reason"). Searching `items` here means every match is
 * found regardless of scroll position; `$lib/transcript/search-
 * highlight.ts` is the DOM-facing half that paints whatever of these
 * matches currently has a mounted row, and `+page.svelte` uses the same
 * `TranscriptJumpTarget` mechanism issue #740 shipped ("jump to this
 * file's diff") to force an off-window match's row into the mounted range
 * before scrolling to it.
 *
 * Field coverage is deliberate, not exhaustive — documented explicitly
 * per issue #203's own "document [collapsed-item coverage] deliberately,
 * not left undefined" acceptance bullet, which #262/#263 inherit the same
 * open question from:
 *   - `message` items (user turns, agent replies, AND agent thoughts) —
 *     the full `text` field. A thought's text lives in the reducer's
 *     state the instant it streams in regardless of whether
 *     `$lib/expand-thoughts.ts`'s current display mode has a body mounted
 *     for it right now, so a collapsed thought's content still counts as
 *     a match (navigating to it brings the row into view; the thought's
 *     own independent collapse state is untouched — see
 *     `search-highlight.ts`'s doc comment for the consequence).
 *   - `tool_call` items — `title`, and `diff.path` when a diff is present
 *     (the filename a reader actually searches for, far more often than
 *     the tool's internal id).
 *   - Never searched: a tool call's `rawInput`/`content`/`diff.oldText`/
 *     `diff.newText` (arbitrary, often huge, non-prose payloads — see
 *     `ToolCallRow`'s own widgets for what actually renders them),
 *     `gap` items (SPEC.md §7.16's resync marker; no text of their own),
 *     and `revival` items (issue #706/#912's revival boundary marker —
 *     its own honesty disclosure, not user/agent prose worth matching).
 */
export type TranscriptSearchField = 'message' | 'tool_title' | 'diff_path';

/** One occurrence of the query string inside `items` — a message containing the query three times over produces three of these, one per occurrence, matching how a browser's own find count works (not one entry per containing row). */
export interface TranscriptSearchMatch {
  readonly itemId: string;
  /** The item's position in `items` at search time — ordering only; `+page.svelte` re-resolves the row by `itemId` when it jumps, never by this index, since a later reducer update can shift positions. */
  readonly itemIndex: number;
  readonly field: TranscriptSearchField;
}

function pushOccurrences(
  out: TranscriptSearchMatch[],
  itemId: string,
  itemIndex: number,
  field: TranscriptSearchField,
  haystack: string,
  needle: string,
): void {
  const lower = haystack.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at === -1) return;
    out.push({ itemId, itemIndex, field });
    from = at + needle.length;
  }
}

/**
 * Every occurrence of `query` across `items`, in transcript order (and, for
 * the several occurrences a single long message can contain, in the order
 * they appear inside it — see {@link pushOccurrences}). Case-insensitive
 * substring match, same as a browser's own find; `query.trim() === ''`
 * returns `[]` rather than matching everything, so an empty search box
 * shows no stale result count instead of "every item matches."
 */
export function searchTranscript(
  items: readonly TranscriptItem[],
  query: string,
): TranscriptSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const matches: TranscriptSearchMatch[] = [];
  items.forEach((item, itemIndex) => {
    if (item.type === 'message') {
      pushOccurrences(matches, item.id, itemIndex, 'message', item.text, needle);
    } else if (item.type === 'tool_call') {
      if (item.title)
        pushOccurrences(matches, item.id, itemIndex, 'tool_title', item.title, needle);
      if (item.diff?.path) {
        pushOccurrences(matches, item.id, itemIndex, 'diff_path', item.diff.path, needle);
      }
    }
    // `gap`/`revival` items carry no searchable text — see the file doc comment.
  });
  return matches;
}
