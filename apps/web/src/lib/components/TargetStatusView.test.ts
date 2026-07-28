// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DecommissionTargetResponse,
  ProvisionTargetResult,
  TargetListEntry,
  TargetUpdateResponse,
} from '$lib/relay-client';
import TargetStatusView, { type TargetActionsClient } from './TargetStatusView.svelte';

// jsdom has no Web Animations API, but Svelte 5's `in:`/`out:` transitions
// (the embedded `AddTargetWizard`'s `Dialog`/`Overlay`, opened reactively by
// the Edit action below) call `element.animate()` under the hood whenever an
// element actually appears AFTER a component's initial mount — unlike every
// existing `Dialog`/`AddTargetWizard` test, which renders with `open: true`
// from the start (Svelte suppresses the *intro* transition on first mount,
// so those never hit this). A minimal no-op stub is enough to let the
// transition run without crashing; it doesn't need to animate anything for
// these assertions to hold.
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = () =>
    ({
      finished: Promise.resolve(),
      cancel: () => {},
      play: () => {},
      pause: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as Animation;
}

afterEach(() => cleanup());

// `loadPercent`/`hostname`/`platform`/`arch` deliberately match what
// `@loombox/node`'s sampler always sends now (issue #507 v5 §3) —
// `cpuPercent` stays present too (mandatory on the wire) but at the SAME
// value, since production nodes mirror it for back-compat; tests that need
// to prove the two are read independently use their own fixtures below.
const HEALTHY = {
  cpuPercent: 40,
  loadPercent: 40,
  memPercent: 60,
  memUsedBytes: 6_000_000_000,
  memTotalBytes: 10_000_000_000,
  diskPercent: 30,
  diskUsedBytes: 30_000_000_000,
  diskTotalBytes: 100_000_000_000,
  healthy: true,
  sampledAt: Date.UTC(2026, 6, 23, 12, 0, 0),
  hostname: 'devbox-node-1',
  platform: 'linux',
  arch: 'x64',
};

const TARGETS: TargetListEntry[] = [
  {
    nodeId: 'node_1',
    targetId: 'local',
    label: 'This machine',
    kind: 'local',
    reachable: true,
    providers: ['claude'],
    health: HEALTHY,
  },
  {
    nodeId: 'node_1',
    targetId: 'ssh_devbox',
    label: 'devbox',
    kind: 'ssh',
    reachable: true,
    // No health sample yet.
    providers: ['claude'],
  },
  {
    nodeId: 'node_2',
    targetId: 'ssh_flaky',
    label: 'flaky box',
    kind: 'ssh',
    reachable: true,
    health: { ...HEALTHY, healthy: false, cpuPercent: 0, memPercent: 0, diskPercent: 0 },
    providers: ['claude'],
  },
  {
    nodeId: 'node_3',
    targetId: 'ssh_offline',
    label: 'offline box',
    kind: 'ssh',
    reachable: false,
    providers: ['claude'],
  },
  {
    nodeId: 'node_4',
    targetId: 'legacy',
    // A node that predates `loadPercent`/`hostname`/`platform`/`arch`
    // entirely (v5 §3's "an older node must not render a hole") — only the
    // wire's pre-existing mandatory fields are present.
    label: 'legacy box',
    kind: 'ssh',
    reachable: true,
    providers: ['claude'],
    health: {
      cpuPercent: 20,
      memPercent: 25,
      memUsedBytes: 2_000_000_000,
      memTotalBytes: 8_000_000_000,
      diskPercent: 15,
      diskUsedBytes: 10_000_000_000,
      diskTotalBytes: 100_000_000_000,
      healthy: true,
      sampledAt: Date.UTC(2026, 6, 23, 12, 0, 0),
    },
  },
];

const noop = () => {};

/** Every meter/sampled-time/action lives behind a per-row disclosure now (v5 design spec §3) — tests that need them must open it first. */
async function expandRow(key: string): Promise<void> {
  await fireEvent.click(screen.getByTestId(`target-row-toggle-${key}`));
}

describe('TargetStatusView (issue #269)', () => {
  it('lists every target with its label, kind, and node id', () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop },
    });

    const rows = screen.getAllByTestId('target-status-row');
    expect(rows).toHaveLength(5);
    expect(screen.getByText('This machine')).toBeTruthy();
    expect(screen.getByText('devbox')).toBeTruthy();
    expect(screen.getByText('flaky box')).toBeTruthy();
    expect(screen.getByText('offline box')).toBeTruthy();
    expect(screen.getByText('legacy box')).toBeTruthy();
  });

  it('shows load/mem/disk percentages for a target with a health reading', () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop },
    });

    const row = screen.getByTestId('target-status-row-node_1:local');
    expect(row.textContent).toContain('40%');
    expect(row.textContent).toContain('60%');
    expect(row.textContent).toContain('30%');
  });

  it("shows 'No data yet' for a target that hasn't reported a health sample", () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop },
    });

    const row = screen.getByTestId('target-status-row-node_1:ssh_devbox');
    expect(row.textContent).toContain('No data yet');
  });

  it('marks a target reachable but failing its own sample as unhealthy, distinct from a node-offline target', () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop },
    });

    const flaky = screen.getByTestId('target-status-row-node_2:ssh_flaky');
    expect(flaky.querySelector('[data-testid="agent-health-badge"]')?.textContent?.trim()).toBe(
      'Unreachable',
    );

    const offline = screen.getByTestId('target-status-row-node_3:ssh_offline');
    expect(offline.querySelector('[data-testid="agent-health-badge"]')?.textContent?.trim()).toBe(
      'Node offline',
    );

    const healthy = screen.getByTestId('target-status-row-node_1:local');
    expect(healthy.querySelector('[data-testid="agent-health-badge"]')?.textContent?.trim()).toBe(
      'Healthy',
    );
  });

  it('flags a target whose usage is very high as overloaded, not merely "healthy"', () => {
    const overloaded: TargetListEntry[] = [
      {
        nodeId: 'node_hot',
        targetId: 'local',
        label: 'hot box',
        providers: ['claude'],
        kind: 'local',
        reachable: true,
        health: { ...HEALTHY, loadPercent: 96, healthy: true },
      },
    ];
    render(TargetStatusView, {
      props: {
        targets: overloaded,
        loading: false,
        error: undefined,
        onRefresh: noop,
      },
    });

    const row = screen.getByTestId('target-status-row-node_hot:local');
    expect(row.querySelector('[data-testid="agent-health-badge"]')?.textContent?.trim()).toBe(
      'Overloaded',
    );
  });

  it('calls onRefresh when the refresh button is clicked', async () => {
    const onRefresh = vi.fn();
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh },
    });

    await fireEvent.click(screen.getByTestId('target-status-refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders no internal title or Close action — the Drawer that hosts this view owns both (redesign v3 spec §3.6 D2)', () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop },
    });
    expect(screen.queryByRole('heading', { name: /nodes.*targets/i })).toBeNull();
    expect(screen.queryByTestId('target-status-close')).toBeNull();
    expect(screen.getByTestId('target-status-refresh')).toBeTruthy();
  });

  it('shows a loading indicator while the first fetch is in flight', () => {
    render(TargetStatusView, {
      props: { targets: [], loading: true, error: undefined, onRefresh: noop },
    });
    expect(screen.getByTestId('woven-loader')).toBeTruthy();
  });

  it('shows the error message when the last refresh failed', () => {
    render(TargetStatusView, {
      props: {
        targets: TARGETS,
        loading: false,
        error: 'timed out waiting for target_list',
        onRefresh: noop,
      },
    });
    expect(screen.getByText(/timed out waiting for target_list/)).toBeTruthy();
  });

  it('shows a fallback message that says what to do next when there are no known targets', () => {
    render(TargetStatusView, {
      props: { targets: [], loading: false, error: undefined, onRefresh: noop },
    });
    expect(screen.queryAllByTestId('target-status-row')).toHaveLength(0);
    expect(screen.getByText(/no nodes or targets connected yet/i)).toBeTruthy();
    expect(screen.getByText(/add a target or connect a node/i)).toBeTruthy();
  });

  it('highlights the row matching focusTarget (issue #269: a stalled session links back to its target)', () => {
    render(TargetStatusView, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        focusTarget: { nodeId: 'node_2', targetId: 'ssh_flaky' },
      },
    });

    const flaky = screen.getByTestId('target-status-row-node_2:ssh_flaky');
    expect(flaky.className).toContain('focused');
    const other = screen.getByTestId('target-status-row-node_1:local');
    expect(other.className).not.toContain('focused');
  });
});

describe('TargetStatusView identity — "which machine" (v5 design spec §3)', () => {
  it("shows the sample's real hostname and platform/arch next to the target label", () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop },
    });

    expect(screen.getByTestId('target-identity-node_1:local').textContent).toBe(
      'devbox-node-1 · linux/x64',
    );
  });

  it('degrades cleanly (no identity segment, no stray "undefined") for an older node that never sent hostname/platform/arch', () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop },
    });

    expect(screen.queryByTestId('target-identity-node_4:legacy')).toBeNull();
    const row = screen.getByTestId('target-status-row-node_4:legacy');
    expect(row.textContent).not.toContain('undefined');
    expect(row.textContent).not.toContain(' · ');
    // The row still reads fine without it — the target's own label survives.
    expect(row.textContent).toContain('legacy box');
  });
});

describe('TargetStatusView load metric (v5 design spec §3: honest label, honest field)', () => {
  it('labels the metric "Load" and reads loadPercent rather than the deprecated cpuPercent', () => {
    const mismatched: TargetListEntry[] = [
      {
        nodeId: 'node_mix',
        targetId: 'local',
        label: 'mixed box',
        kind: 'local',
        reachable: true,
        providers: ['claude'],
        // Deliberately different values so a component that read the wrong
        // field would be caught red-handed.
        health: { ...HEALTHY, cpuPercent: 5, loadPercent: 77 },
      },
    ];
    render(TargetStatusView, {
      props: { targets: mismatched, loading: false, error: undefined, onRefresh: noop },
    });

    const metric = screen.getByTestId('metric-load');
    expect(metric.textContent).toContain('Load');
    expect(metric.textContent).toContain('77%');
    expect(metric.textContent).not.toContain('5%');
  });

  it('shows an em dash rather than silently falling back to cpuPercent when a peer predates loadPercent', () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop },
    });

    // "legacy box" has `cpuPercent: 20` but no `loadPercent` at all.
    const row = screen.getByTestId('target-status-row-node_4:legacy');
    const metric = row.querySelector('[data-testid="metric-load"]');
    expect(metric?.textContent).toContain('—');
    expect(metric?.textContent).not.toContain('20%');
  });
});

describe('TargetStatusView expansion (v5 design spec §3: meters/absolute time/actions move behind a disclosure)', () => {
  it('starts collapsed, then reveals the meters, the absolute sample time, and the actions once opened', async () => {
    render(TargetStatusView, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        client: fakeActionsClient(),
      },
    });

    const toggle = screen.getByTestId('target-row-toggle-node_1:local');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('target-expansion')).toBeNull();
    expect(screen.queryByTestId('load-meter')).toBeNull();
    expect(screen.queryByTestId('target-actions')).toBeNull();

    await fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('load-meter')).toBeTruthy();
    expect(screen.getByTestId('mem-meter')).toBeTruthy();
    expect(screen.getByTestId('disk-meter')).toBeTruthy();
    // Absolute, not the row header's terse relative age — pinned to UTC so
    // this is deterministic regardless of where the test runs.
    expect(screen.getByTestId('target-sampled-at').textContent).toContain(
      'Jul 23, 2026, 12:00:00 PM',
    );
    expect(screen.getByTestId('target-actions')).toBeTruthy();
    expect(screen.getByTestId('target-action-reconnect-node_1:local')).toBeTruthy();

    // Toggling again collapses it back.
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('target-expansion')).toBeNull();
  });
});

function decommissionResponse(
  overrides: Partial<DecommissionTargetResponse> = {},
): DecommissionTargetResponse {
  return {
    type: 'decommission_target_response',
    protocolVersion: 1,
    requestId: 'req-1',
    nodeId: 'node_1',
    targetId: 'ssh_devbox',
    ok: true,
    result: {
      unitWasInstalled: true,
      unitStopped: true,
      unitDisabled: true,
      deviceKeyRevoked: true,
      filesRemoved: false,
    },
    message: 'decommissioned "ssh_devbox"',
    ...overrides,
  };
}

function updateResponse(overrides: Partial<TargetUpdateResponse> = {}): TargetUpdateResponse {
  return {
    type: 'target_update_response',
    protocolVersion: 1,
    requestId: 'req-2',
    nodeId: 'node_1',
    targetId: 'ssh_devbox',
    ok: true,
    status: 'current',
    remoteVersion: '2.0.0',
    installedVersion: '2.0.0',
    message: '"ssh_devbox" is now at 2.0.0',
    ...overrides,
  };
}

function provisionResult(overrides: Partial<ProvisionTargetResult> = {}): ProvisionTargetResult {
  return {
    type: 'provision_target_result',
    protocolVersion: 1,
    requestId: 'req-3',
    nodeId: 'node_1',
    targetId: 'ssh:devbox-replacement',
    ok: true,
    message: 'paired',
    ...overrides,
  };
}

function fakeActionsClient(overrides: Partial<TargetActionsClient> = {}): TargetActionsClient {
  return {
    listTargets: vi.fn().mockResolvedValue(TARGETS),
    provisionTarget: vi.fn().mockResolvedValue(provisionResult()),
    discoverSshHosts: vi.fn().mockResolvedValue({
      outcome: 'ok',
      candidates: [],
      agent: { available: false, identities: [] },
      requiresManualEntry: true,
    }),
    decommissionTarget: vi.fn().mockResolvedValue(decommissionResponse()),
    updateTarget: vi.fn().mockResolvedValue(updateResponse()),
    ...overrides,
  };
}

describe('TargetStatusView connection management (redesign v2 §3.3 Reconnect/Update/Remove/Edit; issue #476)', () => {
  it('renders no per-target actions when no client is passed (existing read-only behavior, unchanged)', () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop },
    });
    expect(screen.queryAllByTestId('target-actions')).toHaveLength(0);
  });

  it('shows Reconnect on every target but Update/Edit/Remove only for ssh: targets', async () => {
    render(TargetStatusView, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        client: fakeActionsClient(),
      },
    });

    await expandRow('node_1:local');
    await expandRow('node_1:ssh_devbox');

    // The local target: Reconnect only.
    expect(screen.getByTestId('target-action-reconnect-node_1:local')).toBeTruthy();
    expect(screen.queryByTestId('target-action-update-node_1:local')).toBeNull();
    expect(screen.queryByTestId('target-action-remove-node_1:local')).toBeNull();
    expect(screen.queryByTestId('target-action-edit-node_1:local')).toBeNull();

    // An ssh: target: all four.
    expect(screen.getByTestId('target-action-reconnect-node_1:ssh_devbox')).toBeTruthy();
    expect(screen.getByTestId('target-action-update-node_1:ssh_devbox')).toBeTruthy();
    expect(screen.getByTestId('target-action-remove-node_1:ssh_devbox')).toBeTruthy();
    expect(screen.getByTestId('target-action-edit-node_1:ssh_devbox')).toBeTruthy();
  });

  it('Reconnect calls onRefresh directly (no wire message of its own)', async () => {
    const onRefresh = vi.fn();
    render(TargetStatusView, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh,
        client: fakeActionsClient(),
      },
    });

    await expandRow('node_1:ssh_devbox');
    await fireEvent.click(screen.getByTestId('target-action-reconnect-node_1:ssh_devbox'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('Update calls client.updateTarget and refreshes on success, showing the outcome message', async () => {
    const onRefresh = vi.fn();
    const updateTarget = vi.fn().mockResolvedValue(updateResponse());
    render(TargetStatusView, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh,
        client: fakeActionsClient({ updateTarget }),
      },
    });

    await expandRow('node_1:ssh_devbox');
    await fireEvent.click(screen.getByTestId('target-action-update-node_1:ssh_devbox'));
    expect(updateTarget).toHaveBeenCalledWith({ nodeId: 'node_1', targetId: 'ssh_devbox' });

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('target-action-message-node_1:ssh_devbox').textContent).toContain(
      'is now at 2.0.0',
    );
  });

  it('Remove requires an explicit confirm step before calling decommissionTarget', async () => {
    const onRefresh = vi.fn();
    const decommissionTarget = vi.fn().mockResolvedValue(decommissionResponse());
    render(TargetStatusView, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh,
        client: fakeActionsClient({ decommissionTarget }),
      },
    });

    await expandRow('node_1:ssh_devbox');

    await fireEvent.click(screen.getByTestId('target-action-remove-node_1:ssh_devbox'));
    expect(decommissionTarget).not.toHaveBeenCalled();
    expect(screen.getByTestId('target-action-remove-confirmbar-node_1:ssh_devbox')).toBeTruthy();

    // Cancel backs out without ever calling the client.
    await fireEvent.click(screen.getByTestId('target-action-remove-cancel-node_1:ssh_devbox'));
    expect(decommissionTarget).not.toHaveBeenCalled();
    expect(screen.queryByTestId('target-action-remove-confirmbar-node_1:ssh_devbox')).toBeNull();

    // Confirming actually removes it.
    await fireEvent.click(screen.getByTestId('target-action-remove-node_1:ssh_devbox'));
    await fireEvent.click(screen.getByTestId('target-action-remove-confirm-node_1:ssh_devbox'));
    expect(decommissionTarget).toHaveBeenCalledWith({
      nodeId: 'node_1',
      targetId: 'ssh_devbox',
    });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it('Edit opens AddTargetWizard prefilled with the target label, and on submit decommissions the old target before provisioning its replacement', async () => {
    const onRefresh = vi.fn();
    const decommissionTarget = vi.fn().mockResolvedValue(decommissionResponse());
    const provisionTarget = vi.fn().mockResolvedValue(provisionResult());
    render(TargetStatusView, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh,
        client: fakeActionsClient({ decommissionTarget, provisionTarget }),
      },
    });

    await expandRow('node_1:ssh_devbox');
    await fireEvent.click(screen.getByTestId('target-action-edit-node_1:ssh_devbox'));

    // Prefilled with the target's label, straight to manual entry (no
    // candidate picker/node-discovery step — the owning node is already
    // known) — see AddTargetWizard's own doc comment for why host/user/port
    // still start blank.
    const labelInput = (await screen.findByTestId('add-target-label')) as HTMLInputElement;
    expect(labelInput.value).toBe('devbox');
    const aliasInput = screen.getByTestId('add-target-alias') as HTMLInputElement;
    expect(aliasInput.value).toBe('devbox');

    await fireEvent.input(screen.getByTestId('add-target-host'), {
      target: { value: '10.0.0.9' },
    });
    await fireEvent.click(screen.getByTestId('add-target-next'));
    await waitFor(() => expect(screen.getByTestId('add-target-review')).toBeTruthy());

    await fireEvent.click(screen.getByTestId('add-target-confirm'));

    await waitFor(() => expect(screen.getByTestId('add-target-success')).toBeTruthy());
    expect(decommissionTarget).toHaveBeenCalledWith({
      nodeId: 'node_1',
      targetId: 'ssh_devbox',
    });
    expect(provisionTarget).toHaveBeenCalled();
    // Both calls happened, decommission before provision (the "teardown
    // then reprovision" order the spec calls for).
    const decommissionOrder = decommissionTarget.mock.invocationCallOrder[0];
    const provisionOrder = provisionTarget.mock.invocationCallOrder[0];
    expect(decommissionOrder).toBeLessThan(provisionOrder);

    await fireEvent.click(screen.getByTestId('add-target-done-close'));
    expect(onRefresh).toHaveBeenCalled();
  });
});
