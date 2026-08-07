import { describe, expect, it } from 'vitest';
import type { AcpPlanEntry } from '@loombox/providers-core/browser';
import { groupPlanEntries, planProgress } from './plan';

const entries: AcpPlanEntry[] = [
  { content: 'Read the spec', status: 'completed' },
  { content: 'Write the code', status: 'in_progress' },
  { content: 'Ship it', status: 'pending' },
  { content: 'Write the tests', status: 'pending' },
];

describe('planProgress', () => {
  it('counts completed entries against the total, not a pre-subtracted "left" figure', () => {
    expect(planProgress(entries)).toEqual({ completed: 1, total: 4 });
  });

  it('is 0 of 0 for an empty plan', () => {
    expect(planProgress([])).toEqual({ completed: 0, total: 0 });
  });

  it('reaches completed === total once every entry is completed', () => {
    const done = entries.map((entry) => ({ ...entry, status: 'completed' }) as const);
    expect(planProgress(done)).toEqual({ completed: 4, total: 4 });
  });
});

describe('groupPlanEntries', () => {
  it('buckets by status in pending/in_progress/completed order, preserving within-bucket order', () => {
    const groups = groupPlanEntries(entries);
    expect(groups.pending.map((k) => k.entry.content)).toEqual(['Ship it', 'Write the tests']);
    expect(groups.inProgress.map((k) => k.entry.content)).toEqual(['Write the code']);
    expect(groups.completed.map((k) => k.entry.content)).toEqual(['Read the spec']);
  });

  it('keys each entry by its original position in the wholesale entries array, not a per-bucket index', () => {
    const groups = groupPlanEntries(entries);
    expect(groups.completed[0]?.key).toBe(0);
    expect(groups.inProgress[0]?.key).toBe(1);
    expect(groups.pending.map((k) => k.key)).toEqual([2, 3]);
  });

  it('an entry that changes status keeps a stable key across two plan_updates, but moves buckets', () => {
    const before = groupPlanEntries(entries);
    expect(before.inProgress[0]?.key).toBe(1);

    const after = groupPlanEntries(
      entries.map((entry, i) => (i === 1 ? { ...entry, status: 'completed' } : entry)),
    );
    // Same original position (key 1), now in the completed bucket instead of in_progress.
    expect(after.inProgress).toHaveLength(0);
    expect(after.completed.map((k) => k.key)).toEqual([0, 1]);
  });

  it('an empty plan groups into three empty buckets', () => {
    expect(groupPlanEntries([])).toEqual({ pending: [], inProgress: [], completed: [] });
  });
});
