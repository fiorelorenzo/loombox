import { describe, expect, it } from 'vitest';

import { ancestorChainForToolCall, createTranscriptState, reduceTranscript } from './transcript';
import type { TranscriptState, TranscriptToolCallItem } from './transcript';
import type {
  AcpMessageChunkUpdate,
  AcpPlanUpdate,
  AcpToolCallUpdate,
  AcpUsageUpdate,
} from './types';

describe('createTranscriptState', () => {
  it('returns an empty initial state', () => {
    expect(createTranscriptState()).toEqual({
      items: [],
      plan: [],
      usage: undefined,
      cumulativeCostUsd: 0,
    });
  });
});

describe('reduceTranscript: message/thought chunks', () => {
  it('coalesces out-of-order chunks for the same turn+kind+id into one item', () => {
    let state = createTranscriptState();

    const agentM1a: AcpMessageChunkUpdate = {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: 'Hello',
    };
    const thoughtM2: AcpMessageChunkUpdate = {
      kind: 'agent_thought_chunk',
      turnId: 't1',
      messageId: 'm2',
      text: 'thinking...',
    };
    const agentM1b: AcpMessageChunkUpdate = {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: ' world',
    };

    // m1's second chunk arrives non-contiguously, after an unrelated m2 chunk.
    state = reduceTranscript(state, agentM1a);
    state = reduceTranscript(state, thoughtM2);
    state = reduceTranscript(state, agentM1b);

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({
      type: 'message',
      kind: 'agent_message_chunk',
      messageId: 'm1',
      text: 'Hello world',
    });
    expect(state.items[1]).toMatchObject({
      type: 'message',
      kind: 'agent_thought_chunk',
      messageId: 'm2',
      text: 'thinking...',
    });
  });

  it('treats a thought and a message reusing the same id in one turn as two items', () => {
    let state = createTranscriptState();

    const thought: AcpMessageChunkUpdate = {
      kind: 'agent_thought_chunk',
      turnId: 't1',
      messageId: 'shared',
      text: 'Thinking',
    };
    const message: AcpMessageChunkUpdate = {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'shared',
      text: 'Answer',
    };

    state = reduceTranscript(state, thought);
    state = reduceTranscript(state, message);

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ kind: 'agent_thought_chunk', text: 'Thinking' });
    expect(state.items[1]).toMatchObject({ kind: 'agent_message_chunk', text: 'Answer' });
  });

  it('scopes ids by turn too: the same id in a later turn starts a new item', () => {
    let state = createTranscriptState();

    state = reduceTranscript(state, {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: 'first turn',
    });
    state = reduceTranscript(state, {
      kind: 'agent_message_chunk',
      turnId: 't2',
      messageId: 'm1',
      text: 'second turn',
    });

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ turnId: 't1', text: 'first turn' });
    expect(state.items[1]).toMatchObject({ turnId: 't2', text: 'second turn' });
  });

  it('does not mutate the input state (pure)', () => {
    const before = createTranscriptState();
    const after = reduceTranscript(before, {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: 'hi',
    });

    expect(before.items).toHaveLength(0);
    expect(after.items).toHaveLength(1);
    expect(after).not.toBe(before);
  });
});

describe('reduceTranscript: tool_call / tool_call_update', () => {
  it('mutates the existing entry in place on tool_call_update, preserving diff fields not resent', () => {
    let state = createTranscriptState();

    const created: AcpToolCallUpdate = {
      kind: 'tool_call',
      id: 'tc1',
      title: 'Edit file',
      toolKind: 'edit',
      status: 'pending',
    };
    const withDiff: AcpToolCallUpdate = {
      kind: 'tool_call_update',
      id: 'tc1',
      status: 'in_progress',
      diff: { path: 'a.ts', oldText: 'a', newText: 'b' },
    };
    const completed: AcpToolCallUpdate = {
      kind: 'tool_call_update',
      id: 'tc1',
      status: 'completed',
      // no diff resent here: the prior diff must survive.
    };

    state = reduceTranscript(state, created);
    state = reduceTranscript(state, withDiff);
    state = reduceTranscript(state, completed);

    expect(state.items).toHaveLength(1);
    const item = state.items[0] as TranscriptToolCallItem;
    expect(item.type).toBe('tool_call');
    expect(item.id).toBe('tc1');
    expect(item.title).toBe('Edit file');
    expect(item.toolKind).toBe('edit');
    expect(item.status).toBe('completed');
    expect(item.diff).toEqual({ path: 'a.ts', oldText: 'a', newText: 'b' });
  });

  it('never appends a duplicate row for a repeated tool-call id', () => {
    let state = createTranscriptState();
    state = reduceTranscript(state, { kind: 'tool_call', id: 'tc1', status: 'pending' });
    state = reduceTranscript(state, { kind: 'tool_call_update', id: 'tc1', status: 'in_progress' });
    state = reduceTranscript(state, { kind: 'tool_call_update', id: 'tc1', status: 'completed' });

    expect(state.items).toHaveLength(1);
  });
});

describe('reduceTranscript: plan_update', () => {
  it('replaces the entire plan wholesale rather than diffing it', () => {
    let state = createTranscriptState();

    const first: AcpPlanUpdate = {
      kind: 'plan_update',
      entries: [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'pending' },
      ],
    };
    const second: AcpPlanUpdate = {
      kind: 'plan_update',
      entries: [{ content: 'c', status: 'in_progress' }],
    };

    state = reduceTranscript(state, first);
    expect(state.plan).toEqual(first.entries);

    state = reduceTranscript(state, second);
    expect(state.plan).toEqual(second.entries);
    expect(state.plan).toHaveLength(1);
  });
});

describe('reduceTranscript: usage_update', () => {
  it('records session-level usage and does not flag it as subagent-attributed by default', () => {
    let state = createTranscriptState();

    const usage: AcpUsageUpdate = {
      kind: 'usage_update',
      sessionId: 'sess1',
      tokensUsed: 1200,
      contextWindow: 200000,
      costUsd: 0.05,
    };
    state = reduceTranscript(state, usage);

    expect(state.usage).toEqual({
      sessionId: 'sess1',
      tokensUsed: 1200,
      contextWindow: 200000,
      costUsd: 0.05,
      attributedToSubagent: false,
    });
    expect(state.cumulativeCostUsd).toBeCloseTo(0.05);
  });

  it('flags a usage_update as subagent-attributed while a nested tool call is in flight', () => {
    let state = createTranscriptState();

    // A nested (subagent) tool call: has a parentToolCallId and is still running.
    const nested: AcpToolCallUpdate = {
      kind: 'tool_call',
      id: 'child1',
      parentToolCallId: 'parent1',
      status: 'in_progress',
    };
    state = reduceTranscript(state, nested);

    const usageDuring: AcpUsageUpdate = {
      kind: 'usage_update',
      sessionId: 'sess1',
      costUsd: 0.01,
    };
    state = reduceTranscript(state, usageDuring);
    expect(state.usage?.attributedToSubagent).toBe(true);

    // Once the nested tool call finishes, later usage is no longer flagged.
    state = reduceTranscript(state, {
      kind: 'tool_call_update',
      id: 'child1',
      status: 'completed',
    });
    const usageAfter: AcpUsageUpdate = {
      kind: 'usage_update',
      sessionId: 'sess1',
      costUsd: 0.02,
    };
    state = reduceTranscript(state, usageAfter);
    expect(state.usage?.attributedToSubagent).toBe(false);

    // Subagent cost still folds into the cumulative figure regardless of attribution (SPEC.md §7.9).
    expect(state.cumulativeCostUsd).toBeCloseTo(0.03);
  });
});

describe('ancestorChainForToolCall', () => {
  function seedNested(): TranscriptState {
    let state = createTranscriptState();
    const root: AcpToolCallUpdate = { kind: 'tool_call', id: 'root' };
    const mid: AcpToolCallUpdate = { kind: 'tool_call', id: 'mid', parentToolCallId: 'root' };
    const leaf: AcpToolCallUpdate = { kind: 'tool_call', id: 'leaf', parentToolCallId: 'mid' };
    state = reduceTranscript(state, root);
    state = reduceTranscript(state, mid);
    state = reduceTranscript(state, leaf);
    return state;
  }

  it('returns the ancestor chain nearest-first for a nested tool call', () => {
    const state = seedNested();
    expect(ancestorChainForToolCall(state.items, 'leaf')).toEqual(['mid', 'root']);
  });

  it('returns [] for a root-level tool call with no parent', () => {
    const state = seedNested();
    expect(ancestorChainForToolCall(state.items, 'root')).toEqual([]);
  });

  it('returns [] for an unknown tool call id (v1 no-op: no bespoke provider populates parentToolCallId yet)', () => {
    const state = seedNested();
    expect(ancestorChainForToolCall(state.items, 'never-existed')).toEqual([]);
  });

  it('never throws on a cyclic chain (defensive against malformed data)', () => {
    let state = createTranscriptState();
    state = reduceTranscript(state, { kind: 'tool_call', id: 'a', parentToolCallId: 'b' });
    state = reduceTranscript(state, { kind: 'tool_call', id: 'b', parentToolCallId: 'a' });
    expect(ancestorChainForToolCall(state.items, 'a')).toEqual(['b']);
  });
});

// A type-level smoke check that TranscriptState is exported with the shape
// the reducer promises (compile-time only, no runtime assertion needed).
function _typeCheck(state: TranscriptState): void {
  void state.items;
  void state.plan;
  void state.usage;
  void state.cumulativeCostUsd;
}
void _typeCheck;
