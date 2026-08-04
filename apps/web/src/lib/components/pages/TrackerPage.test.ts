// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import type { GithubConnectOutcome, JiraConnectOutcome, TrackerMode } from '@loombox/protocol';
import type { TrackerSnapshotState } from '$lib/relay-client';
import TrackerPage, { type TrackerPageClient } from './TrackerPage.svelte';

afterEach(() => cleanup());

const githubMode: TrackerMode = {
  kind: 'live',
  provider: 'github',
  connectionId: 'github:github.com:1111',
  target: { owner: 'fiorelorenzo', repo: 'loombox' },
};

/** Every method `TrackerPageClient` requires — individual tests only override what they exercise. `trackerSnapshotFor` defaults to an already-`'loaded'`, empty snapshot so a test focused on the tracker-MODE loading gate isn't also fighting the (unrelated) tracker-snapshot loading gate. */
function baseClient(overrides: Partial<TrackerPageClient> = {}): TrackerPageClient {
  return {
    trackerSnapshotFor: () =>
      writable<TrackerSnapshotState>({ status: 'loaded', records: [], types: [] }),
    reloadTrackerSnapshot: vi.fn(),
    createTrackerRecord: vi.fn(),
    updateTrackerRecord: vi.fn(),
    defineTrackerType: vi.fn(),
    refreshConnectedAccounts: vi.fn(),
    startGithubConnect: vi.fn(() => ({
      requestId: 'req',
      cancel: vi.fn(),
      result: Promise.withResolvers<GithubConnectOutcome>().promise,
    })),
    connectJiraAccount: vi.fn(() => Promise.withResolvers<JiraConnectOutcome>().promise),
    getTrackerMode: vi.fn(async () => undefined),
    setTrackerMode: vi.fn(async () => undefined),
    ...overrides,
  };
}

function baseProps(overrides: Partial<TrackerPageClient> = {}) {
  return {
    client: baseClient(overrides),
    sessionId: 'session-1',
    projectPath: '/home/dev/proj',
    nodeId: 'node-1',
  };
}

describe('TrackerPage tracker-mode loading gate (issue #631)', () => {
  it('a project with a saved live mode never renders the setup step at any point during load — the intermediate state is a real loading state, not a flash', async () => {
    const { promise, resolve } = Promise.withResolvers<TrackerMode | undefined>();
    const getTrackerMode = vi.fn(() => promise);
    render(TrackerPage, { props: baseProps({ getTrackerMode }) });

    // Assert on the INTERMEDIATE state, before the node round trip
    // resolves — this is the whole point of the test: a project that DOES
    // have a saved mode must not flash "choose a mode" while still loading.
    expect(getTrackerMode).toHaveBeenCalled();
    expect(screen.queryByTestId('tracker-setup')).toBeNull();
    expect(screen.getByTestId('tracker-mode-loading')).toBeTruthy();

    resolve(githubMode);
    await waitFor(() => expect(screen.queryByTestId('tracker-mode-loading')).toBeNull());

    // Settled: renders the live-mode gap note (issue #631's own remaining
    // gap — see TrackerPage.svelte's doc comment), never the setup step.
    expect(screen.queryByTestId('tracker-setup')).toBeNull();
    expect(screen.getByTestId('tracker-live-gap-note')).toBeTruthy();
  });

  it('a project that has genuinely never chosen a mode renders the setup step only once loading settles, never immediately', async () => {
    const { promise, resolve } = Promise.withResolvers<TrackerMode | undefined>();
    render(TrackerPage, { props: baseProps({ getTrackerMode: () => promise }) });

    expect(screen.queryByTestId('tracker-setup')).toBeNull();
    expect(screen.getByTestId('tracker-mode-loading')).toBeTruthy();

    resolve(undefined);
    await waitFor(() => expect(screen.getByTestId('tracker-setup')).toBeTruthy());
  });

  it('a connectivity error loading the tracker mode renders a real, retryable error state, never a silent guess', async () => {
    const getTrackerMode = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay unreachable'))
      .mockResolvedValue(githubMode);
    render(TrackerPage, { props: baseProps({ getTrackerMode }) });

    await waitFor(() => expect(screen.getByTestId('ui-error-notice')).toBeTruthy());
    expect(screen.queryByTestId('tracker-setup')).toBeNull();
    expect(screen.getByTestId('ui-error-notice').textContent).toContain('relay unreachable');
  });

  it('no node bound to the session yet surfaces as a named error, never a guessed "never chosen" setup step', () => {
    const props = baseProps();
    render(TrackerPage, { props: { ...props, nodeId: undefined } });

    expect(screen.queryByTestId('tracker-setup')).toBeNull();
    expect(screen.getByTestId('ui-error-notice')).toBeTruthy();
  });

  it('a mode saved through the setup step is reflected immediately, without waiting for the round trip', async () => {
    const setTrackerMode = vi.fn(
      async (_nodeId: string, _projectPath: string, mode: TrackerMode) => mode,
    );
    render(TrackerPage, {
      props: baseProps({ getTrackerMode: vi.fn(async () => undefined), setTrackerMode }),
    });

    await waitFor(() => expect(screen.getByTestId('tracker-setup')).toBeTruthy());
    // TrackerConfigPanel's own native-mode radio + save, same flow its own
    // test suite exercises directly.
    await fireEvent.click(screen.getByTestId('tracker-mode-native'));
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.queryByTestId('tracker-setup')).toBeNull());
    expect(setTrackerMode).toHaveBeenCalledWith('node-1', '/home/dev/proj', { kind: 'native' });
  });
});
