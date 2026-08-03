import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@loombox/providers-core/browser';
import { showsAttribution } from './transcript-attribution';

function userMsg(id: string): TranscriptItem {
  return {
    type: 'message',
    id,
    kind: 'user_message_chunk',
    turnId: id,
    messageId: id,
    text: 'hi',
  };
}

function agentMsg(id: string): TranscriptItem {
  return {
    type: 'message',
    id,
    kind: 'agent_message_chunk',
    turnId: id,
    messageId: id,
    text: 'hi',
  };
}

function thought(id: string): TranscriptItem {
  return {
    type: 'message',
    id,
    kind: 'agent_thought_chunk',
    turnId: id,
    messageId: id,
    text: 'hmm',
  };
}

function toolCall(id: string): TranscriptItem {
  return {
    type: 'tool_call',
    id,
    turnId: id,
    title: 'Read',
    toolKind: 'read',
    status: 'completed',
    diff: undefined,
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
  };
}

describe('showsAttribution (issue #575: consecutive same-speaker turns do not repeat it)', () => {
  it('shows attribution for the very first message item', () => {
    const items = [agentMsg('a1')];
    expect(showsAttribution(items, 0)).toBe(true);
  });

  it('hides attribution on a second consecutive agent turn', () => {
    const items = [agentMsg('a1'), agentMsg('a2')];
    expect(showsAttribution(items, 0)).toBe(true);
    expect(showsAttribution(items, 1)).toBe(false);
  });

  it('shows attribution again once the speaker actually changes', () => {
    const items = [agentMsg('a1'), userMsg('u1')];
    expect(showsAttribution(items, 1)).toBe(true);
  });

  it('treats an agent thought as the same speaker as an agent message — no third value', () => {
    const items = [agentMsg('a1'), thought('t1')];
    expect(showsAttribution(items, 1)).toBe(false);
  });

  it('does not let an intervening tool call break an agent run', () => {
    const items = [agentMsg('a1'), toolCall('tc1'), agentMsg('a2')];
    expect(showsAttribution(items, 2)).toBe(false);
  });

  it('shows attribution for a tool-only run once a real speaker resumes after several tool calls', () => {
    const items = [
      agentMsg('a1'),
      toolCall('tc1'),
      toolCall('tc2'),
      toolCall('tc3'),
      userMsg('u1'),
    ];
    expect(showsAttribution(items, 4)).toBe(true);
  });

  it('a tool call is never itself asked to carry attribution', () => {
    const items = [agentMsg('a1'), toolCall('tc1')];
    expect(showsAttribution(items, 1)).toBe(false);
  });

  it('shows attribution when a run of tool calls opens the transcript before any message arrives', () => {
    const items = [toolCall('tc1'), agentMsg('a1')];
    expect(showsAttribution(items, 1)).toBe(true);
  });
});
