<script lang="ts">
  /**
   * The aggregate spend-over-time view (SPEC §7.9; issue #249): this
   * project's spend, broken down by provider, over a selectable period.
   * Lives inside `ProjectConfigPanel`'s own "Config" workbench tab
   * (issue #672's own precedent for where a project-scoped, no-session-
   * required panel belongs) rather than a fourth top-level workbench tab
   * — that group was deliberately settled at exactly Files/Config/Runner
   * (`+page.svelte`'s `WORKBENCH_TABS` doc comment, issue #710/#238's
   * `PrOpenPanel`/`CheckpointsDialog` precedent for "a fourth tab is the
   * wrong answer, a Config section is").
   *
   * Addressed by `nodeId` + `projectPath` (`spend-report.ts`'s own doc
   * comment), not a session — mirrors `TrackerPage.svelte`'s identical
   * addressing and its identical reason: a project's spend history
   * outlives any one session that added to it. The "per project" half of
   * "shows spend over time per project/provider" (SPEC §7.9) is this
   * panel's own scoping (open it for whichever project you're
   * configuring); the "per provider" half is the breakdown rendered
   * below, reusing `@loombox/shared`'s `aggregateSpendLedgerRows` — the
   * IDENTICAL function `@loombox/node`'s `NodeDaemon` already runs over
   * `SpendLedgerStore` rows before sealing the reply, never a second,
   * independently-written grouping in the browser.
   *
   * A period with nothing recorded reads as "No spend recorded for this
   * period," never a fabricated `$0.00` — the same honest-"no data"
   * convention `StatusBar.svelte`'s live cost meter documents (that
   * meter shows a real `$0.00` only because a live session's cumulative
   * cost is a genuine running total starting at zero; a *reporting*
   * period with zero rows is a fact this component never has enough
   * information to distinguish from "nobody asked the node yet," so it
   * says so instead of guessing).
   */
  import { onDestroy, onMount } from 'svelte';
  import type { Readable } from 'svelte/store';
  import { aggregateSpendLedgerRows } from '@loombox/shared';
  import type { SpendReportRowV1 } from '@loombox/protocol';
  import type { SpendReportState } from '$lib/relay-client';
  import Badge from './ui/Badge.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Select, { type SelectOption } from './ui/Select.svelte';
  import WovenLoader from './WovenLoader.svelte';

  export interface SpendReportClient {
    spendReportFor(nodeId: string, projectPath: string): Readable<SpendReportState>;
    reloadSpendReport(
      nodeId: string,
      projectPath: string,
      filter?: { sinceDate?: string; untilDate?: string },
    ): void;
  }

  interface Props {
    projectPath: string;
    nodeId?: string;
    client?: SpendReportClient;
  }

  const { projectPath, nodeId, client }: Props = $props();

  type PeriodId = '7d' | '30d' | '90d' | 'all';
  const PERIODS: SelectOption[] = [
    { id: '7d', label: 'Last 7 days' },
    { id: '30d', label: 'Last 30 days' },
    { id: '90d', label: 'Last 90 days' },
    { id: 'all', label: 'All time' },
  ];
  let period = $state<PeriodId>('30d');

  const MS_PER_DAY = 86_400_000;

  /** UTC calendar date, `YYYY-MM-DD`, `days` ago — the request's inclusive `sinceDate` for every period but `'all'`. No I/O, matches `spend-aggregation.ts`'s own "no `Date.now()` inside the pure logic" discipline by staying purely a formatting helper called once per period change, not read reactively inside the aggregation itself. Plain subtraction, never a mutating `setUTCDate` call, so this stays a fresh, never-reused `Date` instance (`svelte/prefer-svelte-reactivity`'s own concern is a MUTATED instance read reactively — this one is neither). */
  function sinceDateFor(days: number): string {
    return new Date(Date.now() - days * MS_PER_DAY).toISOString().slice(0, 10);
  }

  function sinceDateForPeriod(id: PeriodId): string | undefined {
    switch (id) {
      case '7d':
        return sinceDateFor(7);
      case '30d':
        return sinceDateFor(30);
      case '90d':
        return sinceDateFor(90);
      case 'all':
        return undefined;
    }
  }

  let report = $state<SpendReportState>({ status: 'loading', rows: [] });
  let timedOut = $state(false);
  let unsubscribe: (() => void) | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  /** Mirrors `TrackerPage.svelte`'s identical `TIMEOUT_MS` — the same 10s bounded-wait default every other request-shaped `RelayClient` read uses. */
  const TIMEOUT_MS = 10_000;

  function clearBoundedWait(): void {
    if (timeoutHandle === undefined) return;
    clearTimeout(timeoutHandle);
    timeoutHandle = undefined;
  }

  function armBoundedWait(): void {
    clearBoundedWait();
    timeoutHandle = setTimeout(() => {
      timeoutHandle = undefined;
      timedOut = true;
    }, TIMEOUT_MS);
  }

  function subscribe(): void {
    unsubscribe?.();
    if (nodeId === undefined || !client) return;
    unsubscribe = client.spendReportFor(nodeId, projectPath).subscribe((value) => {
      report = value;
      if (value.status === 'loading') {
        if (timeoutHandle === undefined && !timedOut) armBoundedWait();
      } else {
        clearBoundedWait();
        timedOut = false;
      }
    });
  }

  onMount(subscribe);
  onDestroy(() => {
    unsubscribe?.();
    clearBoundedWait();
  });

  // Re-subscribes whenever the caller points this panel at a different
  // project/node — same reactive-key discipline `TrackerPage.svelte`'s
  // own `$effect` documents.
  $effect(() => {
    void nodeId;
    void projectPath;
    subscribe();
    timedOut = false;
  });

  function reload(): void {
    timedOut = false;
    if (nodeId === undefined || !client) return;
    client.reloadSpendReport(nodeId, projectPath, { sinceDate: sinceDateForPeriod(period) });
  }

  function handlePeriodChange(id: string): void {
    period = id as PeriodId;
    reload();
  }

  /** Attaches `projectPath` back onto every wire row (the response omits it — it's already the single project the request addressed, see `spend-report.ts`'s own doc comment) so `aggregateSpendLedgerRows` sees the same row shape `@loombox/node` feeds it. */
  const aggregate = $derived(
    aggregateSpendLedgerRows(
      report.rows.map((row: SpendReportRowV1) => ({ ...row, projectPath })),
    ),
  );

  const providerBreakdown = $derived(
    Object.entries(aggregate.byProvider).sort(([, a], [, b]) => b - a),
  );

  function formatUsd(amount: number): string {
    return `$${amount.toFixed(2)}`;
  }
</script>

<div class="spend-report" data-testid="spend-report-panel">
  <div class="spend-report-controls">
    <Select
      value={period}
      options={PERIODS}
      onChange={handlePeriodChange}
      label="Period"
      size="sm"
      dataTestId="spend-report-period"
    />
  </div>

  {#if nodeId === undefined}
    <p class="spend-report-no-data">Select a session to load this project's spend history.</p>
  {:else if report.status === 'error' || timedOut}
    <ErrorNotice
      message={timedOut
        ? "This project's spend history didn't answer in time. The node isn't reachable right now."
        : (report.error ?? 'Failed to load the spend history.')}
      retryable
      onRetry={reload}
    />
  {:else if report.status === 'loading'}
    <p class="spend-report-loading" data-testid="spend-report-loading">
      <WovenLoader size="sm" label="Loading spend history" />
      Loading…
    </p>
  {:else if !aggregate.hasData}
    <p class="spend-report-no-data" data-testid="spend-report-no-data">
      No spend recorded for this period.
    </p>
  {:else}
    <div class="spend-report-total" data-testid="spend-report-total">
      <span class="spend-report-total-label">Total</span>
      <span class="spend-report-total-value font-mono">{formatUsd(aggregate.totalUsd)}</span>
    </div>
    <ul class="spend-report-providers" data-testid="spend-report-providers">
      {#each providerBreakdown as [provider, costUsd] (provider)}
        <li class="spend-report-provider-row">
          <Badge tone="neutral" size="sm">{provider}</Badge>
          <span class="spend-report-provider-value font-mono">{formatUsd(costUsd)}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .spend-report {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    /* Narrow/mobile viewport parity (`ProjectConfigPanel.svelte`'s own
       `.project-config-section` fix, #174): lets this section shrink
       inside a narrow flex row/column instead of forcing horizontal
       overflow at the 390px mobile floor. */
    min-width: 0;
  }

  .spend-report-controls {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
  }

  .spend-report-loading {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
    margin: 0;
  }

  .spend-report-no-data {
    opacity: 0.6;
    font-size: var(--text-small-size);
    margin: 0;
  }

  .spend-report-total {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-xs);
  }

  .spend-report-total-label {
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }

  .spend-report-total-value {
    font-size: var(--text-body-size);
    font-weight: 600;
  }

  .spend-report-providers {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .spend-report-provider-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-xs);
    /* Same quiet hairline-divided rows `PluginConfigPanel.svelte`'s
       `.plugin-row` already uses. */
    border-top: 1px solid var(--color-border-subtle);
    padding: var(--space-xs) var(--space-2xs);
    /* A long provider id + a wide `Badge` must never force this row
       wider than its column (the same #174 fix every mobile-safe row in
       this codebase applies) — `min-width: 0` alone on the flex child is
       what lets `Badge`'s own text wrap/truncate instead of pushing the
       value off the 390px viewport. */
    min-width: 0;
  }

  .spend-report-provider-row:first-child {
    border-top: none;
    padding-top: 0;
  }

  .spend-report-provider-value {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }
</style>
