import { describe, expect, it } from 'vitest';
import type { AcpTranscriptUpdate } from '@loombox/providers-core';
import { cutTranscriptAtTurn } from './session-fork';

function messageChunk(turnId: string, messageId: string, text: string): AcpTranscriptUpdate {
  return { kind: 'agent_message_chunk', turnId, messageId, text };
}

function userChunk(turnId: string, messageId: string, text: string): AcpTranscriptUpdate {
  return { kind: 'user_message_chunk', turnId, messageId, text };
}

function toolCall(id: string, turnId?: string): AcpTranscriptUpdate {
  return turnId
    ? { kind: 'tool_call', id, turnId, title: 'a tool call' }
    : { kind: 'tool_call', id, title: 'a tool call' };
}

function toolCallUpdate(id: string, status: 'in_progress' | 'completed'): AcpTranscriptUpdate {
  // Deliberately no turnId — a tool_call_update patch commonly omits it,
  // relying on the reducer's own existing item (the case this function
  // exists to handle).
  return { kind: 'tool_call_update', id, status };
}

function planUpdate(): AcpTranscriptUpdate {
  return { kind: 'plan_update', entries: [] };
}

function usageUpdate(): AcpTranscriptUpdate {
  return { kind: 'usage_update', sessionId: 'sess_1', tokensUsed: 10 };
}

describe('cutTranscriptAtTurn (issue #746)', () => {
  it('returns everything up to and including the last update of the target turn', () => {
    const updates = [
      userChunk('t1', 'u1', 'do the thing'),
      messageChunk('t1', 'm1', 'On it.'),
      userChunk('t2', 'u2', 'now the other thing'),
      messageChunk('t2', 'm2', 'Done.'),
    ];

    expect(cutTranscriptAtTurn(updates, 't1')).toEqual(updates.slice(0, 2));
  });

  it('includes a turnId-less tool_call_update that inherits the current turn', () => {
    const updates = [
      userChunk('t1', 'u1', 'edit the file'),
      toolCall('tc1', 't1'),
      toolCallUpdate('tc1', 'completed'),
      messageChunk('t1', 'm1', 'Done.'),
      userChunk('t2', 'u2', 'next turn'),
      messageChunk('t2', 'm2', 'Okay.'),
    ];

    expect(cutTranscriptAtTurn(updates, 't1')).toEqual(updates.slice(0, 4));
  });

  it('includes trailing plan/usage updates (never carry a turnId) that belong to the target turn', () => {
    const updates = [
      userChunk('t1', 'u1', 'plan it out'),
      planUpdate(),
      usageUpdate(),
      messageChunk('t1', 'm1', 'Planned.'),
      userChunk('t2', 'u2', 'go'),
    ];

    expect(cutTranscriptAtTurn(updates, 't1')).toEqual(updates.slice(0, 4));
  });

  it('excludes a plan/usage update that arrives after a later turn has already started', () => {
    const updates = [
      userChunk('t1', 'u1', 'first'),
      messageChunk('t1', 'm1', 'done 1'),
      userChunk('t2', 'u2', 'second'),
      planUpdate(),
    ];

    expect(cutTranscriptAtTurn(updates, 't1')).toEqual(updates.slice(0, 2));
  });

  it('returns the full array when the target turn is the latest one', () => {
    const updates = [userChunk('t1', 'u1', 'only turn'), messageChunk('t1', 'm1', 'only reply')];

    expect(cutTranscriptAtTurn(updates, 't1')).toEqual(updates);
  });

  it('returns undefined for a turn id that never appears', () => {
    const updates = [userChunk('t1', 'u1', 'hi'), messageChunk('t1', 'm1', 'hello')];

    expect(cutTranscriptAtTurn(updates, 'turn-does-not-exist')).toBeUndefined();
  });

  it('returns undefined for an empty transcript', () => {
    expect(cutTranscriptAtTurn([], 't1')).toBeUndefined();
  });
});
