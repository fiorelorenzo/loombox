import { describe, expect, it } from 'vitest';
import type { TranscriptItem, TranscriptToolCallItem } from '@loombox/providers-core/browser';
import { latestTurnDiffSummary, latestTurnId, turnDiffSummary } from './turn-review';

function editCall(
  id: string,
  turnId: string | undefined,
  path: string,
  oldText: string | null,
  newText: string,
): TranscriptToolCallItem {
  return {
    type: 'tool_call',
    id,
    turnId,
    title: `Edit ${path}`,
    toolKind: 'edit',
    status: 'completed',
    diff: { path, oldText, newText },
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
  };
}

function readCall(id: string, turnId: string | undefined): TranscriptToolCallItem {
  return {
    type: 'tool_call',
    id,
    turnId,
    title: 'Read file',
    toolKind: 'read',
    status: 'completed',
    diff: undefined,
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
  };
}

describe('turnDiffSummary', () => {
  it('aggregates every diff-carrying tool call in the turn into one row per file, with correct totals', () => {
    const items: TranscriptItem[] = [
      editCall('tc0', 't1', 'a.ts', 'x', 'x\ny'), // +1/-0
      readCall('tc1', 't1'), // no diff — skipped
      editCall('tc2', 't1', 'b.ts', 'p\nq', 'p'), // +0/-1
      editCall('tc3', 't1', 'c.ts', null, 'new\nfile'), // +2/-0
    ];

    const summary = turnDiffSummary(items, 't1');

    expect(summary).toBeDefined();
    expect(summary!.turnId).toBe('t1');
    expect(summary!.files).toHaveLength(3);
    expect(summary!.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(summary!.files[0]).toMatchObject({ toolCallId: 'tc0', added: 1, removed: 0 });
    expect(summary!.files[1]).toMatchObject({ toolCallId: 'tc2', added: 0, removed: 1 });
    expect(summary!.files[2]).toMatchObject({ toolCallId: 'tc3', added: 2, removed: 0 });
    expect(summary!.totalAdded).toBe(3);
    expect(summary!.totalRemoved).toBe(1);
  });

  it('returns undefined for a turn that touched no files (a read-only turn)', () => {
    const items: TranscriptItem[] = [readCall('tc0', 't1'), readCall('tc1', 't1')];
    expect(turnDiffSummary(items, 't1')).toBeUndefined();
  });

  it('returns undefined for a turn id with no items at all', () => {
    const items: TranscriptItem[] = [editCall('tc0', 't1', 'a.ts', 'x', 'y')];
    expect(turnDiffSummary(items, 'unknown-turn')).toBeUndefined();
  });

  it('only counts diffs belonging to the requested turn, not other turns in the same transcript', () => {
    const items: TranscriptItem[] = [
      editCall('tc0', 't1', 'a.ts', 'x', 'x\ny'),
      editCall('tc1', 't2', 'b.ts', 'p', 'p\nq\nr'),
    ];

    const t1 = turnDiffSummary(items, 't1');
    const t2 = turnDiffSummary(items, 't2');

    expect(t1!.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(t2!.files.map((f) => f.path)).toEqual(['b.ts']);
    expect(t2!.totalAdded).toBe(2);
  });

  it('two edits to the same path in one turn are two separate rows, not merged into one diff', () => {
    const items: TranscriptItem[] = [
      editCall('tc0', 't1', 'a.ts', 'x', 'x\ny'),
      editCall('tc1', 't1', 'a.ts', 'x\ny', 'x\ny\nz'),
    ];

    const summary = turnDiffSummary(items, 't1');

    expect(summary!.files).toHaveLength(2);
    expect(summary!.files.every((f) => f.path === 'a.ts')).toBe(true);
    expect(summary!.files.map((f) => f.toolCallId)).toEqual(['tc0', 'tc1']);
    expect(summary!.totalAdded).toBe(2);
  });

  it('the same diff data a tool card would render — oldText/newText pass through byte for byte', () => {
    const items: TranscriptItem[] = [editCall('tc0', 't1', 'a.ts', 'old content', 'new content')];
    const summary = turnDiffSummary(items, 't1')!;
    expect(summary.files[0]!.oldText).toBe('old content');
    expect(summary.files[0]!.newText).toBe('new content');
  });
});

describe('latestTurnId', () => {
  it('returns the last item’s turnId', () => {
    const items: TranscriptItem[] = [readCall('tc0', 't1'), readCall('tc1', 't2')];
    expect(latestTurnId(items)).toBe('t2');
  });

  it('skips a trailing item with no turnId at all (a malformed wire event, issue #548)', () => {
    const items: TranscriptItem[] = [readCall('tc0', 't1'), readCall('tc1', undefined)];
    expect(latestTurnId(items)).toBe('t1');
  });

  it('returns undefined for an empty transcript', () => {
    expect(latestTurnId([])).toBeUndefined();
  });
});

describe('latestTurnDiffSummary (the turn summary bar’s one data source)', () => {
  it('a turn with three edits produces one summary with three files and correct totals', () => {
    const items: TranscriptItem[] = [
      editCall('tc0', 't1', 'a.ts', 'x', 'x\ny\nz'), // +2/-0
      editCall('tc1', 't1', 'b.ts', 'p\nq\nr', 'p'), // +0/-2
      editCall('tc2', 't1', 'c.ts', null, 'one\ntwo\nthree'), // +3/-0
    ];

    const summary = latestTurnDiffSummary(items);

    expect(summary).toBeDefined();
    expect(summary!.files).toHaveLength(3);
    expect(summary!.totalAdded).toBe(5);
    expect(summary!.totalRemoved).toBe(2);
  });

  it('a turn with no edits produces no summary at all', () => {
    const items: TranscriptItem[] = [readCall('tc0', 't1'), readCall('tc1', 't1')];
    expect(latestTurnDiffSummary(items)).toBeUndefined();
  });

  it('an empty transcript produces no summary', () => {
    expect(latestTurnDiffSummary([])).toBeUndefined();
  });

  it('reflects only the most recent turn — an earlier turn’s edits do not leak into a later, edit-less turn’s bar', () => {
    const items: TranscriptItem[] = [
      editCall('tc0', 't1', 'a.ts', 'x', 'x\ny'),
      readCall('tc1', 't2'),
    ];
    expect(latestTurnDiffSummary(items)).toBeUndefined();
  });
});
