/**
 * The canvas zero state's own "last transcript's tail" preview (B4-2,
 * `docs/superpowers/specs/2026-08-05-zed-parity-decisions.md#B4-2`; issue
 * #739). A pure reduction over a session's full `TranscriptState.items` to
 * just what a hint block needs — who said it and the text — kept in its own
 * dependency-free module (mirrors `keyboard.ts`'s own reasoning) so it is
 * trivial to unit-test without a live `RelayClient` subscription or
 * mounting any component.
 *
 * `items: []` — a session that genuinely has zero turns yet, one of B4-2's
 * two honest empty cases — returns `[]`, never a fabricated example line;
 * `CanvasZeroState.svelte` renders its own "nothing yet" copy for that case
 * rather than this module inventing placeholder content.
 */
import type {
  AcpMessageChunkKind,
  TranscriptItem,
  TranscriptMessageItem,
  TranscriptToolCallItem,
} from '@loombox/providers-core/browser';

/** Who a tail entry reads as: the three live message-chunk kinds `TranscriptState.items` carries, plus `'tool'` for a tool-call item (which has no `kind` of its own). */
export type TranscriptTailSpeaker = 'user' | 'agent' | 'thought' | 'tool';

const MESSAGE_TAIL_SPEAKER: Record<AcpMessageChunkKind, TranscriptTailSpeaker> = {
  user_message_chunk: 'user',
  agent_message_chunk: 'agent',
  agent_thought_chunk: 'thought',
};

export interface TranscriptTailEntry {
  /** The source `TranscriptItem.id`, reused verbatim so a `{#each ... (item.id)}` key never collides across renders. */
  id: string;
  speaker: TranscriptTailSpeaker;
  text: string;
}

/** A tool call carries no single free-text field the way a message does — `title` is the one field every real tool call sends (`TranscriptToolCallItem.title`), so it stands in for the row's text; genuinely absent (never observed on the wire, but the field is optional) falls back to a plain, honest label rather than blank. */
const UNTITLED_TOOL_CALL_LABEL = 'Tool call';

/**
 * The final `limit` items of `items`, collapsed to a speaker + one line of
 * text each. Order is preserved (oldest of the kept tail first, same as
 * `items` itself — SPEC.md §7.24's append-only order), so a caller renders
 * this array top-to-bottom and reads it the same direction as the real
 * transcript.
 */
export function transcriptTail(
  items: readonly TranscriptItem[],
  limit: number,
): TranscriptTailEntry[] {
  // A resync gap (issue #729) has no speaker/text of its own — it never
  // counts toward this preview, exactly like the "zero turns yet" empty
  // case above: skip it rather than inventing a placeholder line for it.
  return items
    .filter((item): item is TranscriptMessageItem | TranscriptToolCallItem => item.type !== 'gap')
    .slice(-limit)
    .map((item) =>
      item.type === 'message'
        ? { id: item.id, speaker: MESSAGE_TAIL_SPEAKER[item.kind], text: item.text }
        : { id: item.id, speaker: 'tool', text: item.title ?? UNTITLED_TOOL_CALL_LABEL },
    );
}
