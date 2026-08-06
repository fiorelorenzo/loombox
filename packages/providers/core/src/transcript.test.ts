import { describe, expect, it } from 'vitest';

import {
  ancestorChainForToolCall,
  createTranscriptState,
  reduceSessionEvent,
  reduceTranscript,
} from './transcript';
import type { TranscriptState, TranscriptToolCallItem } from './transcript';
import type {
  AcpAvailableCommand,
  AcpConfigOption,
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
      status: undefined,
      statusUpdatedAt: undefined,
      statusReason: undefined,
      configOptions: [],
      commands: [],
      turnActive: false,
      lastStopReason: undefined,
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

  it('never merges two malformed tool calls that both carry a missing id (issue #548)', () => {
    // `AcpToolCallUpdate.id` is typed `string`, but nothing on the client
    // validates the decrypted wire payload against that type (see
    // `relay-client.ts`'s `openJson<AcpSessionWireEvent>`), so a real
    // malformed event can carry `id: undefined` at runtime — `as unknown
    // as string` here stands in for that cast, exactly like production
    // traffic would deliver it.
    let state = createTranscriptState();
    state = reduceTranscript(state, {
      kind: 'tool_call',
      id: undefined as unknown as string,
      title: 'First mystery call',
      status: 'completed',
    });
    state = reduceTranscript(state, {
      kind: 'tool_call',
      id: undefined as unknown as string,
      title: 'Second mystery call',
      status: 'pending',
    });

    // Two distinct rows, not one row whose title/status the second event
    // silently overwrote.
    expect(state.items).toHaveLength(2);
    const [first, second] = state.items as TranscriptToolCallItem[];
    expect(first.title).toBe('First mystery call');
    expect(first.status).toBe('completed');
    expect(second.title).toBe('Second mystery call');
    expect(second.status).toBe('pending');
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

    // Subagent cost still folds into the cumulative figure regardless of
    // attribution (SPEC.md §7.9). 0.02, not 0.01+0.02=0.03: ACP's `cost` is
    // a running SESSION TOTAL the agent reports (agentclientprotocol.com's
    // `Cost.amount`: "Total cumulative cost for session"), not a delta to
    // sum — see `reduceUsage`'s comment.
    expect(state.cumulativeCostUsd).toBeCloseTo(0.02);
  });

  it('a subagent usage_update does not move the parent context-fill percentage — sequence: parent, subagent (smaller window), parent again — while its cost is still folded in (issue #248 acceptance)', () => {
    let state = createTranscriptState();

    // 1. A real parent-turn update: 25% of a 200k window.
    state = reduceTranscript(state, {
      kind: 'usage_update',
      sessionId: 'sess1',
      tokensUsed: 50_000,
      contextWindow: 200_000,
      costUsd: 0.1,
    });
    const percentAfterParent1 = Math.round(
      (state.usage!.tokensUsed! / state.usage!.contextWindow!) * 100,
    );
    expect(percentAfterParent1).toBe(25);
    expect(state.cumulativeCostUsd).toBeCloseTo(0.1);

    // 2. A subagent tool call starts.
    state = reduceTranscript(state, {
      kind: 'tool_call',
      id: 'child1',
      parentToolCallId: 'parent1',
      status: 'in_progress',
    });

    // 3. The subagent's OWN usage_update: its context window is tiny (8k)
    // next to the parent's 200k — folding this in directly is exactly the
    // bounce this issue exists to prevent. Its cost IS still real session
    // spend, so the cumulative figure grows.
    state = reduceTranscript(state, {
      kind: 'usage_update',
      sessionId: 'sess1',
      tokensUsed: 3_000,
      contextWindow: 8_000,
      costUsd: 0.115,
    });
    expect(state.usage?.attributedToSubagent).toBe(true);
    // Not "no percentage" (blank) and not the subagent's own 37.5% — the
    // exact SAME numbers as step 1, frozen. This is the assertion that
    // catches "bounces to blank" as well as "bounces to the wrong number":
    // a looser check (e.g. `toBeUndefined()`, or just "isn't 37.5") would
    // pass even if the meter went blank instead of holding steady.
    expect(state.usage?.tokensUsed).toBe(50_000);
    expect(state.usage?.contextWindow).toBe(200_000);
    const percentDuringSubagent = Math.round(
      (state.usage!.tokensUsed! / state.usage!.contextWindow!) * 100,
    );
    expect(percentDuringSubagent).toBe(percentAfterParent1);
    // The subagent's own spend is real session cost even though its context
    // size is excluded from the percentage (SPEC.md §7.9).
    expect(state.cumulativeCostUsd).toBeCloseTo(0.115);

    // 4. The subagent tool call finishes.
    state = reduceTranscript(state, {
      kind: 'tool_call_update',
      id: 'child1',
      status: 'completed',
    });

    // 5. A later real parent-turn update: genuine growth to 31%.
    state = reduceTranscript(state, {
      kind: 'usage_update',
      sessionId: 'sess1',
      tokensUsed: 62_000,
      contextWindow: 200_000,
      costUsd: 0.13,
    });
    expect(state.usage?.attributedToSubagent).toBe(false);
    const percentAfterParent2 = Math.round(
      (state.usage!.tokensUsed! / state.usage!.contextWindow!) * 100,
    );
    expect(percentAfterParent2).toBe(31);

    // Monotonic across the whole sequence: 25 -> 25 (frozen, not bounced) -> 31.
    expect([percentAfterParent1, percentDuringSubagent, percentAfterParent2]).toEqual([25, 25, 31]);
    expect(state.cumulativeCostUsd).toBeCloseTo(0.13);
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

describe('reduceSessionEvent: session_status', () => {
  it('records the pushed status and its timestamp', () => {
    const state = reduceSessionEvent(createTranscriptState(), {
      kind: 'session_status',
      status: 'awaiting_input',
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    expect(state.status).toBe('awaiting_input');
    expect(state.statusUpdatedAt).toBe('2026-07-16T00:00:00.000Z');
  });

  it('the latest status event wins, replacing an earlier one', () => {
    let state = reduceSessionEvent(createTranscriptState(), {
      kind: 'session_status',
      status: 'working',
      updatedAt: 't1',
    });
    state = reduceSessionEvent(state, {
      kind: 'session_status',
      status: 'permission_required',
      updatedAt: 't2',
    });
    expect(state.status).toBe('permission_required');
    expect(state.statusUpdatedAt).toBe('t2');
  });

  it('records an "error" status\'s reason (issue #730)', () => {
    const state = reduceSessionEvent(createTranscriptState(), {
      kind: 'session_status',
      status: 'error',
      updatedAt: '2026-07-16T00:00:00.000Z',
      reason: 'agent spawn did not complete within 120000ms',
    });
    expect(state.status).toBe('error');
    expect(state.statusReason).toBe('agent spawn did not complete within 120000ms');
  });

  it('clears a stale reason once a later status transition arrives without one', () => {
    let state = reduceSessionEvent(createTranscriptState(), {
      kind: 'session_status',
      status: 'error',
      updatedAt: 't1',
      reason: 'agent spawn timed out',
    });
    expect(state.statusReason).toBe('agent spawn timed out');
    state = reduceSessionEvent(state, {
      kind: 'session_status',
      status: 'working',
      updatedAt: 't2',
    });
    expect(state.status).toBe('working');
    expect(state.statusReason).toBeUndefined();
  });
});

describe('reduceSessionEvent: config_options / config_option_update', () => {
  const catalog: AcpConfigOption[] = [
    { category: 'model', current: 'sonnet', choices: [{ id: 'sonnet', name: 'Sonnet' }] },
  ];

  it('config_options replaces the whole catalog wholesale', () => {
    const state = reduceSessionEvent(createTranscriptState(), {
      kind: 'config_options',
      options: catalog,
    });
    expect(state.configOptions).toEqual(catalog);
  });

  it('config_option_update (the unprompted variant) also replaces the whole catalog wholesale, never patching in place', () => {
    let state = reduceSessionEvent(createTranscriptState(), {
      kind: 'config_options',
      options: catalog,
    });
    const fallback: AcpConfigOption[] = [
      { category: 'model', current: 'haiku', choices: [{ id: 'haiku', name: 'Haiku' }] },
    ];
    state = reduceSessionEvent(state, { kind: 'config_option_update', options: fallback });
    expect(state.configOptions).toEqual(fallback);
  });

  it('does not mutate the option objects passed in (defensive clone)', () => {
    const state = reduceSessionEvent(createTranscriptState(), {
      kind: 'config_options',
      options: catalog,
    });
    state.configOptions[0]!.choices.push({ id: 'opus', name: 'Opus' });
    expect(catalog[0]!.choices).toHaveLength(1);
  });
});

describe('reduceSessionEvent: available_commands_update', () => {
  const commands: AcpAvailableCommand[] = [
    { name: 'model', description: 'Show current model selection', input: undefined },
  ];

  it('replaces the whole command catalog wholesale', () => {
    const state = reduceSessionEvent(createTranscriptState(), {
      kind: 'available_commands_update',
      commands,
    });
    expect(state.commands).toEqual(commands);
  });

  it('a later available_commands_update replaces the list wholesale, never patching in place', () => {
    let state = reduceSessionEvent(createTranscriptState(), {
      kind: 'available_commands_update',
      commands,
    });
    const redeclared: AcpAvailableCommand[] = [
      { name: 'jobs', description: 'Show background jobs', input: undefined },
    ];
    state = reduceSessionEvent(state, { kind: 'available_commands_update', commands: redeclared });
    expect(state.commands).toEqual(redeclared);
  });

  it('an agent that declares no commands leaves the catalog empty, not an error', () => {
    const state = reduceSessionEvent(createTranscriptState(), {
      kind: 'available_commands_update',
      commands: [],
    });
    expect(state.commands).toEqual([]);
  });

  it('preserves an unrecognized/future field on a command (defensive clone, not a narrowing one)', () => {
    const withUnknownField: AcpAvailableCommand[] = [
      { name: 'security', description: 'Run a scan', input: undefined, icon: 'shield' },
    ];
    const state = reduceSessionEvent(createTranscriptState(), {
      kind: 'available_commands_update',
      commands: withUnknownField,
    });
    expect(state.commands[0]?.icon).toBe('shield');
  });

  it('does not mutate the command objects passed in (defensive clone)', () => {
    const state = reduceSessionEvent(createTranscriptState(), {
      kind: 'available_commands_update',
      commands,
    });
    state.commands[0]!.description = 'tampered';
    expect(commands[0]?.description).toBe('Show current model selection');
  });
});

describe('reduceSessionEvent: turn_started / turn_ended', () => {
  it('turn_started flips turnActive on', () => {
    const state = reduceSessionEvent(createTranscriptState(), {
      kind: 'turn_started',
      turnId: 'turn:1',
    });
    expect(state.turnActive).toBe(true);
  });

  it('turn_ended flips turnActive off and records the stopReason', () => {
    let state = reduceSessionEvent(createTranscriptState(), {
      kind: 'turn_started',
      turnId: 'turn:1',
    });
    state = reduceSessionEvent(state, {
      kind: 'turn_ended',
      turnId: 'turn:1',
      stopReason: 'end_turn',
    });
    expect(state.turnActive).toBe(false);
    expect(state.lastStopReason).toBe('end_turn');
  });

  it('turn_ended with no stopReason still settles the turn', () => {
    let state = reduceSessionEvent(createTranscriptState(), {
      kind: 'turn_started',
      turnId: 'turn:1',
    });
    state = reduceSessionEvent(state, {
      kind: 'turn_ended',
      turnId: undefined,
      stopReason: undefined,
    });
    expect(state.turnActive).toBe(false);
    expect(state.lastStopReason).toBeUndefined();
  });
});

describe('reduceSessionEvent: delegates every AcpTranscriptUpdate kind unchanged to reduceTranscript', () => {
  it('agent_message_chunk still reduces into a transcript item', () => {
    const state = reduceSessionEvent(createTranscriptState(), {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: 'Hello',
    });
    expect(state.items).toEqual([
      {
        type: 'message',
        id: 't1::agent_message_chunk::m1',
        kind: 'agent_message_chunk',
        turnId: 't1',
        messageId: 'm1',
        text: 'Hello',
      },
    ]);
  });

  it('a lifecycle event never touches the transcript items/plan/usage fields', () => {
    let state = createTranscriptState();
    state = reduceTranscript(state, {
      kind: 'plan_update',
      entries: [{ content: 'x', status: 'pending' }],
    });
    state = reduceSessionEvent(state, { kind: 'turn_started', turnId: 'turn:1' });
    expect(state.plan).toEqual([{ content: 'x', status: 'pending' }]);
  });
});

// A type-level smoke check that TranscriptState is exported with the shape
// the reducer promises (compile-time only, no runtime assertion needed).
function _typeCheck(state: TranscriptState): void {
  void state.items;
  void state.plan;
  void state.usage;
  void state.cumulativeCostUsd;
  void state.status;
  void state.statusUpdatedAt;
  void state.configOptions;
  void state.commands;
  void state.turnActive;
  void state.lastStopReason;
  void state.statusReason;
}
void _typeCheck;
