import { describe, expect, it } from 'vitest';
import {
  computeToolCallNesting,
  type TranscriptItem,
  type TranscriptToolCallItem,
} from '@loombox/providers-core/browser';
import {
  findDisplayIndexForItemId,
  groupToolCallBursts,
  TOOL_CALL_BURST_THRESHOLD,
  type ToolCallBurstGroupItem,
} from './tool-call-bursts';

function toolCallItem(
  id: string,
  extra: Partial<TranscriptToolCallItem> = {},
): TranscriptToolCallItem {
  return {
    type: 'tool_call',
    id,
    turnId: 't1',
    title: `tool ${id}`,
    toolKind: undefined,
    status: 'completed',
    diff: undefined,
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
    ...extra,
  };
}

function toolCalls(count: number, prefix = 'tc'): TranscriptToolCallItem[] {
  return Array.from({ length: count }, (_, i) => toolCallItem(`${prefix}${i}`));
}

function messageItem(id: string): TranscriptItem {
  return {
    type: 'message',
    id,
    kind: 'agent_message_chunk',
    turnId: 't1',
    messageId: id,
    text: id,
  };
}

/** Runs the real two-step pipeline `TranscriptTimeline.svelte` itself runs: nesting first, over the FULL transcript, then grouping off that map — never a hand-built nesting stub, so these tests exercise the exact same orphan/depth resolution issue #200 already proved. */
function group(items: readonly TranscriptItem[]) {
  return groupToolCallBursts(items, computeToolCallNesting(items));
}

describe('groupToolCallBursts: the threshold (issue #202)', () => {
  it('a run at exactly the threshold stays ungrouped — "above a threshold" per the issue body', () => {
    const items = toolCalls(TOOL_CALL_BURST_THRESHOLD);
    const result = group(items);
    expect(result).toHaveLength(TOOL_CALL_BURST_THRESHOLD);
    expect(result.every((item) => item.type === 'tool_call')).toBe(true);
  });

  it('one more call than the threshold collapses the whole run into one group', () => {
    const items = toolCalls(TOOL_CALL_BURST_THRESHOLD + 1);
    const result = group(items);
    expect(result).toHaveLength(1);
    const only = result[0]!;
    expect(only.type).toBe('tool_call_group');
    expect((only as ToolCallBurstGroupItem).calls).toHaveLength(TOOL_CALL_BURST_THRESHOLD + 1);
  });

  it('a short run (below threshold) between two long runs stays flat, not folded into either neighbor', () => {
    const items: TranscriptItem[] = [
      ...toolCalls(TOOL_CALL_BURST_THRESHOLD + 2, 'a'),
      messageItem('m'),
      toolCallItem('lone'),
      messageItem('m2'),
      ...toolCalls(TOOL_CALL_BURST_THRESHOLD + 3, 'b'),
    ];
    const result = group(items);
    // group(a), message, lone tool_call, message, group(b)
    expect(result).toHaveLength(5);
    expect(result[0]!.type).toBe('tool_call_group');
    expect(result[1]!.type).toBe('message');
    expect(result[2]!.type).toBe('tool_call');
    expect(result[3]!.type).toBe('message');
    expect(result[4]!.type).toBe('tool_call_group');
    expect((result[0] as ToolCallBurstGroupItem).calls).toHaveLength(TOOL_CALL_BURST_THRESHOLD + 2);
    expect((result[4] as ToolCallBurstGroupItem).calls).toHaveLength(TOOL_CALL_BURST_THRESHOLD + 3);
  });

  it('a message interrupting an otherwise-long run breaks it into two runs, neither reaching the threshold on its own', () => {
    const items: TranscriptItem[] = [
      ...toolCalls(TOOL_CALL_BURST_THRESHOLD, 'a'),
      messageItem('m'),
      ...toolCalls(TOOL_CALL_BURST_THRESHOLD, 'b'),
    ];
    const result = group(items);
    expect(result.filter((item) => item.type === 'tool_call_group')).toHaveLength(0);
    expect(result).toHaveLength(TOOL_CALL_BURST_THRESHOLD * 2 + 1);
  });
});

describe('groupToolCallBursts: nesting scope (issues #200 + #202)', () => {
  it('a root-level call that launches a subagent joins the preceding root-level run (same scope), and its own children form a separate group right after', () => {
    const items: TranscriptItem[] = [
      ...toolCalls(TOOL_CALL_BURST_THRESHOLD + 1, 'root'),
      toolCallItem('sub', { title: 'Run subagent' }),
      ...Array.from({ length: TOOL_CALL_BURST_THRESHOLD + 1 }, (_, i) =>
        toolCallItem(`child${i}`, { parentToolCallId: 'sub' }),
      ),
    ];
    const result = group(items);
    // `sub` is itself root-level (depth 0, same scope as the run before
    // it), so it extends that SAME run rather than breaking it — a root
    // burst that happens to end in a subagent launch is still one root
    // burst. Its children resolve a DIFFERENT scope (parent `sub`), so
    // they form their own, separate group immediately after.
    expect(result).toHaveLength(2);
    const rootGroup = result[0] as ToolCallBurstGroupItem;
    expect(rootGroup.type).toBe('tool_call_group');
    expect(rootGroup.depth).toBe(0);
    expect(rootGroup.calls).toHaveLength(TOOL_CALL_BURST_THRESHOLD + 2);
    expect(rootGroup.calls.at(-1)!.id).toBe('sub');

    const childGroup = result[1] as ToolCallBurstGroupItem;
    expect(childGroup.type).toBe('tool_call_group');
    expect(childGroup.depth).toBe(1);
    expect(childGroup.parentTitle).toBe('Run subagent');
    expect(childGroup.calls).toHaveLength(TOOL_CALL_BURST_THRESHOLD + 1);
  });

  it('two different subagents’ children arriving back to back never merge into one group, even with nothing textually between them', () => {
    const items: TranscriptItem[] = [
      toolCallItem('subA'),
      toolCallItem('subB'),
      ...toolCalls(TOOL_CALL_BURST_THRESHOLD + 1, 'a').map((c) => ({
        ...c,
        parentToolCallId: 'subA',
      })),
      ...toolCalls(TOOL_CALL_BURST_THRESHOLD + 1, 'b').map((c) => ({
        ...c,
        parentToolCallId: 'subB',
      })),
    ];
    const result = group(items);
    const groups = result.filter(
      (item): item is ToolCallBurstGroupItem => item.type === 'tool_call_group',
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.calls.every((c) => c.parentToolCallId === 'subA')).toBe(true);
    expect(groups[1]!.calls.every((c) => c.parentToolCallId === 'subB')).toBe(true);
  });

  it('an orphan child (parentToolCallId never resolved) groups with genuine root-level calls, not excluded by its own dangling id', () => {
    const items: TranscriptItem[] = [
      ...toolCalls(TOOL_CALL_BURST_THRESHOLD, 'root'),
      toolCallItem('orphan', { parentToolCallId: 'never-arrived' }),
    ];
    const result = group(items);
    expect(result).toHaveLength(1);
    const only = result[0] as ToolCallBurstGroupItem;
    expect(only.type).toBe('tool_call_group');
    expect(only.depth).toBe(0);
    expect(only.calls).toHaveLength(TOOL_CALL_BURST_THRESHOLD + 1);
    expect(only.calls.at(-1)!.id).toBe('orphan');
  });

  it('a chain of strictly-increasing depth (root -> a -> b -> c) never groups: every consecutive pair has a different scope', () => {
    const items: TranscriptItem[] = [
      toolCallItem('root'),
      toolCallItem('a', { parentToolCallId: 'root' }),
      toolCallItem('b', { parentToolCallId: 'a' }),
      toolCallItem('c', { parentToolCallId: 'b' }),
    ];
    const result = group(items);
    expect(result.every((item) => item.type === 'tool_call')).toBe(true);
    expect(result).toHaveLength(4);
  });
});

describe('groupToolCallBursts: streaming stability (this ticket’s own hard requirement)', () => {
  it('a group keeps the identical id across every tick as the run keeps growing, never re-forming under a new id', () => {
    const base = toolCalls(TOOL_CALL_BURST_THRESHOLD + 1);
    const firstTick = group(base);
    expect(firstTick).toHaveLength(1);
    const groupId = firstTick[0]!.id;
    expect(groupId).toBe(`tool_call_group::${base[0]!.id}`);

    for (let extra = 1; extra <= 20; extra += 1) {
      const items = [...base, ...toolCalls(extra, 'extra')];
      const tick = group(items);
      expect(tick).toHaveLength(1);
      expect(tick[0]!.id).toBe(groupId);
      expect((tick[0] as ToolCallBurstGroupItem).calls).toHaveLength(base.length + extra);
    }
  });

  it('a run already closed by a non-tool_call item never reopens once more items stream in after it', () => {
    const closedRun = toolCalls(TOOL_CALL_BURST_THRESHOLD + 1, 'closed');
    const boundary = messageItem('boundary-msg');
    const tick1 = group([...closedRun, boundary]);
    expect(tick1).toHaveLength(2);
    const closedGroupId = tick1[0]!.id;

    // More root-level calls stream in after the message boundary — a
    // fresh run, still below threshold. The already-closed group before
    // the boundary must be byte-for-byte the same entry, not re-merged
    // with anything new that arrives after it.
    const tick2 = group([...closedRun, boundary, ...toolCalls(3, 'after')]);
    expect(tick2[0]!.id).toBe(closedGroupId);
    expect((tick2[0] as ToolCallBurstGroupItem).calls).toHaveLength(TOOL_CALL_BURST_THRESHOLD + 1);
    expect(tick2[1]!.type).toBe('message');
    expect(tick2).toHaveLength(2 + 3);
  });

  it('crossing the threshold is the one deliberate, one-time transition — not a re-shuffle on every subsequent tick', () => {
    const seen: string[][] = [];
    for (let n = 1; n <= TOOL_CALL_BURST_THRESHOLD + 3; n += 1) {
      const tick = group(toolCalls(n));
      seen.push(tick.map((item) => item.id));
    }
    // Below/at threshold: one row per call, growing by exactly one id each tick.
    for (let n = 0; n < TOOL_CALL_BURST_THRESHOLD; n += 1) {
      expect(seen[n]).toHaveLength(n + 1);
    }
    // The instant the run exceeds the threshold, every subsequent tick is
    // exactly one row: the same group id, never a different one.
    const groupIds = seen.slice(TOOL_CALL_BURST_THRESHOLD).map((tick) => tick[0]);
    expect(new Set(groupIds).size).toBe(1);
    expect(groupIds[0]).toBe('tool_call_group::tc0');
  });
});

describe('findDisplayIndexForItemId (issue #740 / #262 / #202 interaction)', () => {
  it('resolves a standalone item id directly', () => {
    const items = toolCalls(3);
    const displayItems = group(items);
    expect(findDisplayIndexForItemId(displayItems, 'tc1')).toBe(1);
  });

  it('resolves a raw id folded into a burst group to the GROUP’s own index', () => {
    const items: TranscriptItem[] = [
      messageItem('m0'),
      ...toolCalls(TOOL_CALL_BURST_THRESHOLD + 4),
    ];
    const displayItems = group(items);
    expect(displayItems).toHaveLength(2); // [message, group]
    expect(findDisplayIndexForItemId(displayItems, 'tc2')).toBe(1);
  });

  it('returns -1 for an id this transcript never produced', () => {
    const items = toolCalls(3);
    const displayItems = group(items);
    expect(findDisplayIndexForItemId(displayItems, 'never-existed')).toBe(-1);
  });
});
