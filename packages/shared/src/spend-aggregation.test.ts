import { describe, expect, it } from 'vitest';

import {
  aggregateSpendLedgerRows,
  filterSpendLedgerRows,
  type SpendAggregationRow,
} from './spend-aggregation';

/**
 * The known fixture set issue #249's acceptance names: two projects, two
 * providers, spend spread across three different UTC dates, chosen so a
 * naive "sum everything" implementation and a correct per-project/
 * per-provider grouping would disagree on at least one total.
 */
const FIXTURE: SpendAggregationRow[] = [
  { date: '2026-08-01', projectPath: '/proj-alpha', provider: 'claude', costUsd: 1.5 },
  { date: '2026-08-01', projectPath: '/proj-alpha', provider: 'codex', costUsd: 0.75 },
  { date: '2026-08-02', projectPath: '/proj-alpha', provider: 'claude', costUsd: 2.25 },
  { date: '2026-08-02', projectPath: '/proj-beta', provider: 'claude', costUsd: 4.0 },
  { date: '2026-08-03', projectPath: '/proj-beta', provider: 'codex', costUsd: 3.1 },
];

describe('aggregateSpendLedgerRows', () => {
  it('sums a known fixture set into exactly the expected per-project totals', () => {
    const result = aggregateSpendLedgerRows(FIXTURE);
    expect(result.byProject).toEqual({
      '/proj-alpha': 1.5 + 0.75 + 2.25,
      '/proj-beta': 4.0 + 3.1,
    });
  });

  it('sums a known fixture set into exactly the expected per-provider totals', () => {
    const result = aggregateSpendLedgerRows(FIXTURE);
    expect(result.byProvider).toEqual({
      claude: 1.5 + 2.25 + 4.0,
      codex: 0.75 + 3.1,
    });
  });

  it('sums to the exact expected grand total and reports hasData: true', () => {
    const result = aggregateSpendLedgerRows(FIXTURE);
    expect(result.totalUsd).toBeCloseTo(1.5 + 0.75 + 2.25 + 4.0 + 3.1, 10);
    expect(result.hasData).toBe(true);
  });

  it('a project or provider absent from the fixture never appears as a 0 entry', () => {
    const result = aggregateSpendLedgerRows(FIXTURE);
    expect(result.byProject).not.toHaveProperty('/proj-gamma');
    expect(result.byProvider).not.toHaveProperty('gemini');
  });

  it('a period with no matching rows reports hasData: false, empty breakdowns, never an invented zero standing in for a real measurement', () => {
    const noRowsInRange = filterSpendLedgerRows(FIXTURE, {
      sinceDate: '2099-01-01',
      untilDate: '2099-01-31',
    });
    const result = aggregateSpendLedgerRows(noRowsInRange);
    expect(result).toEqual({ totalUsd: 0, byProject: {}, byProvider: {}, hasData: false });
  });

  it('an empty row set (e.g. a brand-new project) also reports hasData: false', () => {
    expect(aggregateSpendLedgerRows([])).toEqual({
      totalUsd: 0,
      byProject: {},
      byProvider: {},
      hasData: false,
    });
  });
});

describe('filterSpendLedgerRows', () => {
  it('filters to exactly one project', () => {
    const result = filterSpendLedgerRows(FIXTURE, { projectPath: '/proj-beta' });
    expect(result).toHaveLength(2);
    expect(result.every((row) => row.projectPath === '/proj-beta')).toBe(true);
  });

  it('filters to exactly one provider', () => {
    const result = filterSpendLedgerRows(FIXTURE, { provider: 'codex' });
    expect(result).toHaveLength(2);
    expect(result.every((row) => row.provider === 'codex')).toBe(true);
  });

  it('sinceDate/untilDate bounds are inclusive on both ends', () => {
    const result = filterSpendLedgerRows(FIXTURE, {
      sinceDate: '2026-08-02',
      untilDate: '2026-08-02',
    });
    expect(result).toEqual([
      { date: '2026-08-02', projectPath: '/proj-alpha', provider: 'claude', costUsd: 2.25 },
      { date: '2026-08-02', projectPath: '/proj-beta', provider: 'claude', costUsd: 4.0 },
    ]);
  });

  it('combining every filter narrows to the exact intersection', () => {
    const result = filterSpendLedgerRows(FIXTURE, {
      projectPath: '/proj-alpha',
      provider: 'claude',
      sinceDate: '2026-08-02',
    });
    expect(result).toEqual([
      { date: '2026-08-02', projectPath: '/proj-alpha', provider: 'claude', costUsd: 2.25 },
    ]);
  });

  it('an omitted filter field matches everything, never acting as an implicit exclusion', () => {
    expect(filterSpendLedgerRows(FIXTURE, {})).toEqual(FIXTURE);
    expect(filterSpendLedgerRows(FIXTURE)).toEqual(FIXTURE);
  });
});
