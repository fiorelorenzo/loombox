// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get, writable, type Writable } from 'svelte/store';
import type { TestRunnerCommandsV1 } from '@loombox/protocol';
import type { RunClientState } from '$lib/relay-client';
import RunnerPanel, { type RunnerClient } from './RunnerPanel.svelte';

afterEach(() => cleanup());

interface FakeRunnerClient extends RunnerClient {
  runsStore: Writable<Map<string, RunClientState>>;
  outputListeners: Map<string, (chunk: Uint8Array) => void>;
}

/** The single runId `startRun` most recently created (this fake never has more than one active run per test). */
function soleRunId(client: FakeRunnerClient): string {
  const ids = [...get(client.runsStore).keys()];
  const runId = ids[ids.length - 1];
  if (!runId) throw new Error('soleRunId: no run started yet');
  return runId;
}

function fakeClient(overrides: Partial<RunnerClient> = {}): FakeRunnerClient {
  const runsStore = writable<Map<string, RunClientState>>(new Map());
  const outputListeners = new Map<string, (chunk: Uint8Array) => void>();
  let nextRunId = 1;
  return {
    getTestRunnerConfig: vi.fn().mockResolvedValue({}),
    startRun: vi.fn((sessionId: string, kind) => {
      const runId = `run-${nextRunId++}`;
      runsStore.update((map) => {
        const next = new Map(map);
        next.set(runId, { runId, kind, status: 'starting' });
        return next;
      });
      return runId;
    }),
    cancelRun: vi.fn(),
    onRunOutput: vi.fn(
      (sessionId: string, runId: string, listener: (chunk: Uint8Array) => void) => {
        outputListeners.set(runId, listener);
        return () => outputListeners.delete(runId);
      },
    ),
    runsFor: () => runsStore,
    runsStore,
    outputListeners,
    ...overrides,
  };
}

function setRunState(client: FakeRunnerClient, runId: string, state: RunClientState): void {
  client.runsStore.update((map) => {
    const next = new Map(map);
    next.set(runId, state);
    return next;
  });
}

describe('RunnerPanel (issue #244)', () => {
  it('shows an empty state instead of fetching anything when there is no active session', () => {
    const client = fakeClient();
    render(RunnerPanel, { props: { client } });

    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
    expect(client.getTestRunnerConfig).not.toHaveBeenCalled();
  });

  it('shows an empty state (no fetched command buttons) when nothing is configured', async () => {
    const client = fakeClient({ getTestRunnerConfig: vi.fn().mockResolvedValue({}) });
    render(RunnerPanel, { props: { sessionId: 'sess-1', client } });

    await waitFor(() => expect(client.getTestRunnerConfig).toHaveBeenCalledWith('sess-1'));
    await waitFor(() => expect(screen.getByTestId('ui-empty-state')).toBeTruthy());
  });

  it('renders a Run action only for each configured kind — a subset when only some are configured', async () => {
    const commands: TestRunnerCommandsV1 = { test: 'pnpm test', build: 'pnpm build' };
    const client = fakeClient({ getTestRunnerConfig: vi.fn().mockResolvedValue(commands) });
    render(RunnerPanel, { props: { sessionId: 'sess-1', client } });

    await waitFor(() => expect(screen.getByTestId('test-runner-run-button-test')).toBeTruthy());
    expect(screen.getByTestId('test-runner-run-button-build')).toBeTruthy();
    expect(screen.queryByTestId('test-runner-run-button-lint')).toBeNull();
  });

  it('clicking Run starts a run, streams live output into it, and settles to a pass summary on run_exit', async () => {
    const client = fakeClient({
      getTestRunnerConfig: vi.fn().mockResolvedValue({ test: 'pnpm test' }),
    });
    render(RunnerPanel, { props: { sessionId: 'sess-1', client } });

    const runButton = await screen.findByTestId('test-runner-run-button-test');
    await fireEvent.click(runButton);

    expect(client.startRun).toHaveBeenCalledWith('sess-1', 'test');
    const runId = soleRunId(client);

    // The button flips to Cancel while the run is starting/running.
    await waitFor(() => expect(screen.getByTestId('test-runner-cancel-test')).toBeTruthy());
    expect(screen.queryByTestId('test-runner-run-button-test')).toBeNull();

    // Streaming: a chunk delivered through the listener this panel registered
    // shows up in the live output, before the run has exited.
    setRunState(client, runId, { runId, kind: 'test', status: 'running' });
    const listener = client.outputListeners.get(runId);
    expect(listener).toBeTruthy();
    listener!(new TextEncoder().encode('PASS src/foo.test.ts\n'));
    await waitFor(() =>
      expect(screen.getByTestId('terminal-body').textContent).toContain('PASS src/foo.test.ts'),
    );

    // Exit: the run settles, the button flips back to Run.
    setRunState(client, runId, {
      runId,
      kind: 'test',
      status: 'exited',
      outcome: 'pass',
      exitCode: 0,
    });
    await waitFor(() => expect(screen.getByTestId('test-runner-run-button-test')).toBeTruthy());
    expect(screen.queryByTestId('test-runner-cancel-test')).toBeNull();
  });

  it('clicking Cancel while a run is in flight calls cancelRun with its runId', async () => {
    const client = fakeClient({
      getTestRunnerConfig: vi.fn().mockResolvedValue({ lint: 'pnpm lint' }),
    });
    render(RunnerPanel, { props: { sessionId: 'sess-1', client } });

    const runButton = await screen.findByTestId('test-runner-run-button-lint');
    await fireEvent.click(runButton);
    const runId = soleRunId(client);
    setRunState(client, runId, { runId, kind: 'lint', status: 'running' });

    const cancelButton = await screen.findByTestId('test-runner-cancel-lint');
    await fireEvent.click(cancelButton);

    expect(client.cancelRun).toHaveBeenCalledWith('sess-1', runId);
  });

  it('surfaces a load failure through ErrorNotice rather than hanging or throwing', async () => {
    const client = fakeClient({
      getTestRunnerConfig: vi.fn().mockRejectedValue(new Error('node unreachable')),
    });
    render(RunnerPanel, { props: { sessionId: 'sess-1', client } });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('node unreachable'),
    );
  });
});
