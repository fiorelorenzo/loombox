import type { TranscriptState } from '@loombox/providers-core';

/**
 * Whether a thought item is still "live" — the source for `MessageItem`'s
 * ticking "Thinking Ns" header (SPEC.md §7.24 "Thinking/reasoning", issue
 * #136). A thought settles to a static "Thought for Ns" the instant either
 * of the two things §7.24 calls out happens: real message content starts
 * arriving for the same turn, or the turn itself ends — both collapse to
 * one check here, since `TranscriptState.turnActive` already goes `false`
 * the moment `turn_ended` lands (`@loombox/providers-core`'s
 * `reduceSessionEvent`), so a thought whose turn has ended is never
 * reported as still thinking even if no message chunk ever arrived for it
 * (e.g. a turn that ended in an error before producing an answer).
 *
 * Scoped by `turnId`, not the item's own id, per §7.24's "scope
 * transcript-item ids by turn + kind, not raw messageId alone, since a
 * provider may reuse ids across a thought and a message within the same
 * turn" — this only cares whether *this turn* has produced message content
 * yet, not whether this exact messageId has.
 */
export function isThoughtStillThinking(
  transcript: Pick<TranscriptState, 'items' | 'turnActive'>,
  turnId: string,
): boolean {
  if (!transcript.turnActive) return false;
  return !transcript.items.some(
    (item) =>
      item.type === 'message' && item.kind === 'agent_message_chunk' && item.turnId === turnId,
  );
}
