import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@loombox/providers-core/browser';
import { transcriptTail } from './transcript-tail';

function message(
  id: string,
  kind: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
): TranscriptItem {
  return { type: 'message', id, kind, turnId: 'turn_1', messageId: id, text };
}

function toolCall(id: string, title: string | undefined): TranscriptItem {
  return {
    type: 'tool_call',
    id,
    turnId: 'turn_1',
    title,
    toolKind: undefined,
    status: undefined,
    diff: undefined,
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
  };
}

describe('transcriptTail (B4-2, issue #739)', () => {
  it('returns [] for a session with zero turns — the honest empty case, never a fabricated line', () => {
    expect(transcriptTail([], 3)).toEqual([]);
  });

  it('keeps only the final `limit` items, oldest-of-the-kept-tail first (same order as TranscriptState.items)', () => {
    const items = [
      message('m1', 'user_message_chunk', 'first'),
      message('m2', 'agent_message_chunk', 'second'),
      message('m3', 'user_message_chunk', 'third'),
      message('m4', 'agent_message_chunk', 'fourth'),
    ];

    expect(transcriptTail(items, 2)).toEqual([
      { id: 'm3', speaker: 'user', text: 'third' },
      { id: 'm4', speaker: 'agent', text: 'fourth' },
    ]);
  });

  it('maps every real message-chunk kind to its own speaker', () => {
    const items = [
      message('m1', 'user_message_chunk', 'hi'),
      message('m2', 'agent_thought_chunk', 'thinking...'),
      message('m3', 'agent_message_chunk', 'reply'),
    ];

    expect(transcriptTail(items, 3).map((entry) => entry.speaker)).toEqual([
      'user',
      'thought',
      'agent',
    ]);
  });

  it("a tool-call item reads as 'tool', its text pulled from `title`", () => {
    const items = [toolCall('t1', 'Run tests')];
    expect(transcriptTail(items, 3)).toEqual([{ id: 't1', speaker: 'tool', text: 'Run tests' }]);
  });

  it('an untitled tool call falls back to a plain honest label, not blank', () => {
    const items = [toolCall('t1', undefined)];
    expect(transcriptTail(items, 3)).toEqual([{ id: 't1', speaker: 'tool', text: 'Tool call' }]);
  });

  it('a limit larger than the item count returns every item, no padding', () => {
    const items = [message('m1', 'user_message_chunk', 'only one')];
    expect(transcriptTail(items, 5)).toHaveLength(1);
  });
});
