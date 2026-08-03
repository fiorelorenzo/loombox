/**
 * Consecutive-turn attribution grouping (design spec
 * `2026-08-03-cockpit-v6-design.md` §3.4, issue #575, direction point 5:
 * "consecutive turns from the same speaker should not repeat the
 * attribution"). `+page.svelte`'s transcript loop calls `showsAttribution`
 * for every `TranscriptMessageItem` it renders and passes the result as
 * `MessageItem`'s `showAttribution` prop, which hides the visible provider
 * glyph (never the `.sr-only` accessible label — see that component's own
 * doc comment) when this turn is a direct continuation of the immediately
 * preceding SPEAKER.
 *
 * A tool-call item is not a speaker of its own — it is always part of
 * whichever agent turn produced it — so a tool call sitting between two
 * agent messages does not break the run: `speakerKey` returns `undefined`
 * for it, and the backward scan below skips past it rather than treating it
 * as "a different speaker interrupted".
 */
import type { TranscriptItem } from '@loombox/providers-core/browser';

export type SpeakerKey = 'user' | 'agent';

/** `undefined` for a tool-call item — it never carries its own speaker. */
export function speakerKey(item: TranscriptItem): SpeakerKey | undefined {
  if (item.type !== 'message') return undefined;
  return item.kind === 'user_message_chunk' ? 'user' : 'agent';
}

/**
 * Whether the message item at `index` should show its visible attribution
 * (glyph). True for the first message item in the transcript, and true
 * whenever the nearest preceding message item (skipping any tool-call rows
 * in between) has a different `speakerKey`. `items[index]` itself must be a
 * `'message'` item — a tool call never renders a glyph at all, so this is
 * never asked about one.
 */
export function showsAttribution(items: readonly TranscriptItem[], index: number): boolean {
  const current = speakerKey(items[index]);
  if (current === undefined) return false;
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = speakerKey(items[i]);
    if (previous === undefined) continue;
    return previous !== current;
  }
  return true;
}
