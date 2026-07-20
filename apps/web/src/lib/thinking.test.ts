import { describe, expect, it } from 'vitest';
import {
  createTranscriptState,
  reduceTranscript,
  type TranscriptState,
} from '@loombox/providers-core';
import { isThoughtStillThinking } from './thinking';

function withThought(turnId: string): TranscriptState {
  return reduceTranscript(createTranscriptState(), {
    kind: 'agent_thought_chunk',
    turnId,
    messageId: 'm1',
    text: 'reasoning',
  });
}

describe('isThoughtStillThinking (#136)', () => {
  it('is thinking while the turn is active and no message chunk has arrived for it yet', () => {
    const state = { ...withThought('t1'), turnActive: true };
    expect(isThoughtStillThinking(state, 't1')).toBe(true);
  });

  it('settles the instant a message chunk arrives for the same turn, even if the turn is still active', () => {
    let state = withThought('t1');
    state = reduceTranscript(state, {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm2',
      text: 'the answer',
    });
    state = { ...state, turnActive: true };
    expect(isThoughtStillThinking(state, 't1')).toBe(false);
  });

  it('settles once the turn is no longer active, even with no message content at all', () => {
    const state = { ...withThought('t1'), turnActive: false };
    expect(isThoughtStillThinking(state, 't1')).toBe(false);
  });

  it('does not settle on a message chunk from a different turn', () => {
    let state = withThought('t1');
    state = reduceTranscript(state, {
      kind: 'agent_message_chunk',
      turnId: 't2',
      messageId: 'm2',
      text: 'unrelated turn',
    });
    state = { ...state, turnActive: true };
    expect(isThoughtStillThinking(state, 't1')).toBe(true);
  });
});
