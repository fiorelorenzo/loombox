/**
 * Pure grouping logic over `SpendLedgerStore` rows (SPEC §7.9; issue
 * #249) — the "shared aggregation source" issue #249's own acceptance
 * demands: this is the one place a set of `SpendLedgerRow`s becomes a
 * per-project/per-provider rollup, used both by
 * `node-daemon.ts`'s handlers (filtering a `spend_report_request`'s date
 * range before sealing the reply) and directly by this file's own test
 * suite, which is what proves "a known fixture set produces exactly the
 * expected totals" against real numbers rather than against whatever the
 * wire handler happens to do internally.
 *
 * No I/O, no `Date.now()` — every date bound is an explicit `YYYY-MM-DD`
 * string the caller supplies, so this module is trivially deterministic
 * to test.
 */

import type { SpendLedgerRow } from './spend-ledger-store';

export interface SpendLedgerFilter {
  projectPath?: string;
  provider?: string;
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  sinceDate?: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  untilDate?: string;
}

/** Narrows `rows` to the ones matching every given filter field — an omitted field matches everything, exactly like `SpendCapStore.get`'s "no cap" reading undefined rather than a wildcard value. */
export function filterSpendLedgerRows(
  rows: readonly SpendLedgerRow[],
  filter: SpendLedgerFilter = {},
): SpendLedgerRow[] {
  return rows.filter((row) => {
    if (filter.projectPath !== undefined && row.projectPath !== filter.projectPath) return false;
    if (filter.provider !== undefined && row.provider !== filter.provider) return false;
    if (filter.sinceDate !== undefined && row.date < filter.sinceDate) return false;
    if (filter.untilDate !== undefined && row.date > filter.untilDate) return false;
    return true;
  });
}

export interface SpendAggregateV1 {
  totalUsd: number;
  /** Keyed by `projectPath` — only projects with at least one matching row appear here at all, never a `0` entry for one that simply wasn't asked about or had nothing recorded. */
  byProject: Record<string, number>;
  /** Keyed by `provider` — same "present only if it has real rows" rule as `byProject`. */
  byProvider: Record<string, number>;
  /**
   * `false` when `rows` was empty — the caller's signal to render "no
   * data for this period" rather than a fabricated `$0.00` (SPEC §7.9's
   * live-meter convention, `StatusBar.svelte`'s own doc comment). A
   * period that genuinely has rows always has `hasData: true`, even
   * though `totalUsd`/`byProject`/`byProvider` are mathematically real
   * sums over an empty set either way — `hasData` is what tells the two
   * cases apart, not the numbers themselves.
   */
  hasData: boolean;
}

/** Sums `rows` (already filtered to whatever period/project/provider the caller cares about — see {@link filterSpendLedgerRows}) into per-project and per-provider totals. */
export function aggregateSpendLedgerRows(rows: readonly SpendLedgerRow[]): SpendAggregateV1 {
  const byProject: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  let totalUsd = 0;
  for (const row of rows) {
    byProject[row.projectPath] = (byProject[row.projectPath] ?? 0) + row.costUsd;
    byProvider[row.provider] = (byProvider[row.provider] ?? 0) + row.costUsd;
    totalUsd += row.costUsd;
  }
  return { totalUsd, byProject, byProvider, hasData: rows.length > 0 };
}
