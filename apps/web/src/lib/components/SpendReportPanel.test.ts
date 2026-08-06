// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import type { SpendReportRowV1 } from '@loombox/protocol';
import type { SpendReportState } from '$lib/relay-client';
import SpendReportPanel, { type SpendReportClient } from './SpendReportPanel.svelte';

afterEach(() => cleanup());

/**
 * The same known fixture set `@loombox/shared`'s own
 * `spend-aggregation.test.ts` uses (two providers, spend on three
 * different UTC dates), proving this panel's client-side pipeline —
 * `RelayClient.spendReportFor` -> `aggregateSpendLedgerRows` -> the
 * rendered breakdown — produces the exact same per-provider totals the
 * shared function's own unit tests already prove in isolation.
 */
const FIXTURE_ROWS: SpendReportRowV1[] = [
  { date: '2026-08-01', provider: 'claude', costUsd: 1.5 },
  { date: '2026-08-01', provider: 'codex', costUsd: 0.75 },
  { date: '2026-08-02', provider: 'claude', costUsd: 2.25 },
];

function baseClient(overrides: Partial<SpendReportClient> = {}): SpendReportClient {
  return {
    spendReportFor: () => writable<SpendReportState>({ status: 'loading', rows: [] }),
    reloadSpendReport: vi.fn(),
    ...overrides,
  };
}

function baseProps(overrides: Partial<SpendReportClient> = {}) {
  return {
    client: baseClient(overrides),
    projectPath: '/home/dev/proj',
    nodeId: 'node-1',
  };
}

describe('SpendReportPanel (SPEC §7.9; issue #249)', () => {
  it('renders a loading state before the store settles', () => {
    render(SpendReportPanel, { props: baseProps() });
    expect(screen.getByTestId('spend-report-loading')).toBeTruthy();
  });

  it('sums a known fixture into the exact expected total and per-provider breakdown', async () => {
    const store = writable<SpendReportState>({ status: 'loading', rows: [] });
    render(SpendReportPanel, {
      props: baseProps({ spendReportFor: () => store }),
    });
    store.set({ status: 'loaded', rows: FIXTURE_ROWS });

    await waitFor(() => expect(screen.getByTestId('spend-report-total')).toBeTruthy());
    expect(screen.getByTestId('spend-report-total').textContent).toContain('$4.50');

    const providerRows = screen.getByTestId('spend-report-providers').textContent ?? '';
    expect(providerRows).toContain('claude');
    expect(providerRows).toContain('$3.75');
    expect(providerRows).toContain('codex');
    expect(providerRows).toContain('$0.75');
  });

  it('a period with no rows reads as an honest "no data" message, never a fabricated $0.00', async () => {
    const store = writable<SpendReportState>({ status: 'loading', rows: [] });
    render(SpendReportPanel, {
      props: baseProps({ spendReportFor: () => store }),
    });
    store.set({ status: 'loaded', rows: [] });

    await waitFor(() => expect(screen.getByTestId('spend-report-no-data')).toBeTruthy());
    expect(screen.getByTestId('spend-report-no-data').textContent).toContain(
      'No spend recorded for this period.',
    );
    expect(screen.queryByTestId('spend-report-total')).toBeNull();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('an error store renders a retryable ErrorNotice that calls back into reloadSpendReport', async () => {
    const store = writable<SpendReportState>({
      status: 'error',
      rows: [],
      error: 'node unreachable',
    });
    const reloadSpendReport = vi.fn();
    render(SpendReportPanel, {
      props: baseProps({ spendReportFor: () => store, reloadSpendReport }),
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('node unreachable');

    screen.getByRole('button', { name: 'Retry' }).click();
    expect(reloadSpendReport).toHaveBeenCalledWith(
      'node-1',
      '/home/dev/proj',
      expect.objectContaining({ sinceDate: expect.any(String) }),
    );
  });

  it('with no nodeId yet, shows an explanatory message and never calls the client', () => {
    const spendReportFor = vi.fn();
    render(SpendReportPanel, {
      props: { ...baseProps({ spendReportFor }), nodeId: undefined },
    });
    expect(spendReportFor).not.toHaveBeenCalled();
    expect(screen.getByText("Select a session to load this project's spend history.")).toBeTruthy();
  });
});
