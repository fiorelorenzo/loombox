// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DecommissionTargetResponse,
  NodeSelfUpdateApplyResponse,
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

  it('renders the load percentage — a numeric figure — in the shared mono identifier face (#735)', () => {
    const mismatched: TargetListEntry[] = [
      {
        nodeId: 'node_mix',
        targetId: 'local',
        kind: 'local',
        label: 'mixed',
        reachable: true,
        providers: ['claude'],
        health: { ...HEALTHY, cpuPercent: 5, loadPercent: 77 },
      },
    ];
    render(TargetStatusView, {
      props: { targets: mismatched, loading: false, error: undefined, onRefresh: noop },
    });
    expect(screen.getByTestId('metric-load').querySelector('.metric-value')?.className).toContain(
      'font-mono',
    );
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

  it('renders the meter percentages/bytes and the sampled-at timestamp — numeric figures — in the shared mono identifier face (#735)', async () => {
    render(TargetStatusView, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        client: fakeActionsClient(),
      },
    });
    await fireEvent.click(screen.getByTestId('target-row-toggle-node_1:local'));
    const expansion = screen.getByTestId('target-expansion');
    for (const value of expansion.querySelectorAll('.meter-value')) {
      expect(value.className).toContain('font-mono');
    }
    expect(screen.getByTestId('target-sampled-at').querySelector('.font-mono')).toBeTruthy();
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

function nodeSelfUpdateApplyResponse(
  overrides: Partial<NodeSelfUpdateApplyResponse> = {},
): NodeSelfUpdateApplyResponse {
  return {
    type: 'node_self_update_apply_response',
    protocolVersion: 1,
    requestId: 'req-4',
    nodeId: 'node_1',
    ok: true,
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    message: 'updated 1.0.0 -> 2.0.0; restarting to apply',
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
    applyNodeSelfUpdate: vi.fn().mockResolvedValue(nodeSelfUpdateApplyResponse()),
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

describe('TargetStatusView build identity (issue #655)', () => {
  const BUILD_TARGETS: TargetListEntry[] = [
    {
      nodeId: 'node_same',
      targetId: 'local',
      label: 'Same build',
      kind: 'local',
      reachable: true,
      providers: ['claude'],
      build: { version: '0.5.1', commit: 'relay-sha' },
    },
    {
      nodeId: 'node_drifted',
      targetId: 'local',
      label: 'Drifted build',
      kind: 'local',
      reachable: true,
      providers: ['claude'],
      build: { version: '0.5.1', commit: 'drifted-sha' },
    },
    {
      nodeId: 'node_unknown',
      targetId: 'local',
      label: 'No identity at all',
      kind: 'local',
      reachable: true,
      providers: ['claude'],
      // No build field — a node that predates #655.
    },
  ];
  const RELAY_BUILD = { version: '0.5.1', commit: 'relay-sha' };

  it('shows the node\u2019s own version and stays silent (no Behind badge) when it matches the relay — outcome 1', () => {
    render(TargetStatusView, {
      props: {
        targets: BUILD_TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        relayBuildIdentity: RELAY_BUILD,
      },
    });
    expect(screen.getByTestId('target-build-node_same:local').textContent).toBe('v0.5.1');
    expect(screen.queryByTestId('target-behind-node_same:local')).toBeNull();
  });

  it('flags a node whose build differs from the relay with a Behind badge on its own row — outcome 2, the one that does not exist before #655', () => {
    render(TargetStatusView, {
      props: {
        targets: BUILD_TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        relayBuildIdentity: RELAY_BUILD,
      },
    });
    expect(screen.getByTestId('target-behind-node_drifted:local').textContent?.trim()).toBe(
      'Behind',
    );
    // Still fully listed, not refused — the row itself renders normally.
    expect(screen.getByText('Drifted build')).toBeTruthy();
  });

  it('never flags a node with no build identity at all as behind — unknown is not a claim this view can back up', () => {
    render(TargetStatusView, {
      props: {
        targets: BUILD_TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        relayBuildIdentity: RELAY_BUILD,
      },
    });
    expect(screen.queryByTestId('target-build-node_unknown:local')).toBeNull();
    expect(screen.queryByTestId('target-behind-node_unknown:local')).toBeNull();
  });

  it('never flags anything as behind when this client has no relayBuildIdentity yet (no handshake landed)', () => {
    render(TargetStatusView, {
      props: { targets: BUILD_TARGETS, loading: false, error: undefined, onRefresh: noop },
    });
    expect(screen.queryByTestId('target-behind-node_drifted:local')).toBeNull();
  });
});

describe('TargetStatusView node self-update (issue #656)', () => {
  const SELF_UPDATE_TARGETS: TargetListEntry[] = [
    {
      nodeId: 'node_current',
      targetId: 'local',
      label: 'Up to date node',
      kind: 'local',
      reachable: true,
      providers: ['claude'],
      nodeSelfUpdate: {
        status: 'current',
        currentVersion: '2.0.0',
        checkedAt: Date.UTC(2026, 6, 23, 12, 0, 0),
      },
    },
    {
      nodeId: 'node_stale',
      targetId: 'local',
      label: 'Stale node',
      kind: 'local',
      reachable: true,
      providers: ['claude'],
      nodeSelfUpdate: {
        status: 'update_available',
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        checkedAt: Date.UTC(2026, 6, 23, 12, 0, 0),
      },
    },
    {
      nodeId: 'node_no_check',
      targetId: 'local',
      label: 'Never checked',
      kind: 'local',
      reachable: true,
      providers: ['claude'],
      // No `nodeSelfUpdate` at all — an older node, or one whose first
      // check hasn't completed yet.
    },
  ];

  it('shows an "Update available" badge only for a node whose self-update check found something newer', () => {
    render(TargetStatusView, {
      props: { targets: SELF_UPDATE_TARGETS, loading: false, error: undefined, onRefresh: noop },
    });
    expect(screen.queryByTestId('target-node-update-available-node_current:local')).toBeNull();
    expect(
      screen.getByTestId('target-node-update-available-node_stale:local').textContent?.trim(),
    ).toBe('Update available');
    expect(screen.queryByTestId('target-node-update-available-node_no_check:local')).toBeNull();
  });

  it('renders no "Update node" action when no client is passed, even with an update available', () => {
    render(TargetStatusView, {
      props: { targets: SELF_UPDATE_TARGETS, loading: false, error: undefined, onRefresh: noop },
    });
    expect(screen.queryAllByTestId('target-actions')).toHaveLength(0);
  });

  it('shows "Update node" only for the node with an update available, never for one already current', async () => {
    render(TargetStatusView, {
      props: {
        targets: SELF_UPDATE_TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        client: fakeActionsClient(),
      },
    });

    await expandRow('node_current:local');
    await expandRow('node_stale:local');

    expect(screen.queryByTestId('target-action-node-self-update-node_current:local')).toBeNull();
    expect(screen.getByTestId('target-action-node-self-update-node_stale:local')).toBeTruthy();
  });

  it('Update node calls client.applyNodeSelfUpdate with the owning nodeId, refreshes on success, and shows the outcome message', async () => {
    const onRefresh = vi.fn();
    const applyNodeSelfUpdate = vi.fn().mockResolvedValue(nodeSelfUpdateApplyResponse());
    render(TargetStatusView, {
      props: {
        targets: SELF_UPDATE_TARGETS,
        loading: false,
        error: undefined,
        onRefresh,
        client: fakeActionsClient({ applyNodeSelfUpdate }),
      },
    });

    await expandRow('node_stale:local');
    await fireEvent.click(screen.getByTestId('target-action-node-self-update-node_stale:local'));
    expect(applyNodeSelfUpdate).toHaveBeenCalledWith({ nodeId: 'node_stale' });

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('target-action-message-node_stale:local').textContent).toContain(
      'updated 1.0.0 -> 2.0.0',
    );
  });

  it('a failed apply never refreshes, and shows the failure message on the row instead', async () => {
    const onRefresh = vi.fn();
    const applyNodeSelfUpdate = vi.fn().mockResolvedValue(
      nodeSelfUpdateApplyResponse({
        ok: false,
        toVersion: undefined,
        message: 'a session is actively working on a turn; wait for it to finish before updating',
      }),
    );
    render(TargetStatusView, {
      props: {
        targets: SELF_UPDATE_TARGETS,
        loading: false,
        error: undefined,
        onRefresh,
        client: fakeActionsClient({ applyNodeSelfUpdate }),
      },
    });

    await expandRow('node_stale:local');
    await fireEvent.click(screen.getByTestId('target-action-node-self-update-node_stale:local'));
    await waitFor(() =>
      expect(screen.getByTestId('target-action-message-node_stale:local')).toBeTruthy(),
    );
    expect(screen.getByTestId('target-action-message-node_stale:local').textContent).toContain(
      'actively working on a turn',
    );
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe('TargetStatusView concurrency (issue #255)', () => {
  const LOCAL_KEY = 'node_1:local';

  it('shows the running/cap slot count and the cap\u2019s honest source for a target that reports a limit', () => {
    const targets: TargetListEntry[] = [
      {
        nodeId: 'node_1',
        targetId: 'local',
        label: 'This machine',
        kind: 'local',
        reachable: true,
        providers: ['claude'],
        maxConcurrentSessions: 4,
        maxConcurrentSessionsSource: 'default',
      },
    ];
    render(TargetStatusView, {
      props: {
        targets,
        loading: false,
        error: undefined,
        onRefresh: noop,
        concurrency: new Map([[LOCAL_KEY, { running: 2, queued: 0 }]]),
      },
    });

    const cap = screen.getByTestId(`target-concurrency-cap-${LOCAL_KEY}`);
    expect(cap.textContent).toBe('2/4');
    const source = screen.getByTestId(`target-concurrency-source-${LOCAL_KEY}`);
    expect(source.textContent).toBe('default');
    expect(screen.queryByTestId(`target-concurrency-queued-${LOCAL_KEY}`)).toBeNull();
  });

  it('reads "configured" instead of "default" once an operator has set the cap explicitly', () => {
    const targets: TargetListEntry[] = [
      {
        nodeId: 'node_1',
        targetId: 'local',
        label: 'This machine',
        kind: 'local',
        reachable: true,
        providers: ['claude'],
        maxConcurrentSessions: 8,
        maxConcurrentSessionsSource: 'configured',
      },
    ];
    render(TargetStatusView, {
      props: { targets, loading: false, error: undefined, onRefresh: noop },
    });

    expect(screen.getByTestId(`target-concurrency-source-${LOCAL_KEY}`).textContent).toBe(
      'configured',
    );
  });

  it('surfaces a distinct queued badge, with the waiting count, whenever a target has a nonzero queue', () => {
    const targets: TargetListEntry[] = [
      {
        nodeId: 'node_1',
        targetId: 'local',
        label: 'This machine',
        kind: 'local',
        reachable: true,
        providers: ['claude'],
        maxConcurrentSessions: 2,
        maxConcurrentSessionsSource: 'default',
      },
    ];
    render(TargetStatusView, {
      props: {
        targets,
        loading: false,
        error: undefined,
        onRefresh: noop,
        concurrency: new Map([[LOCAL_KEY, { running: 2, queued: 3 }]]),
      },
    });

    const badge = screen.getByTestId(`target-concurrency-queued-${LOCAL_KEY}`);
    expect(badge.textContent?.trim()).toBe('3 queued');
  });

  it('renders no cap/slots reading at all for a target from a node that predates issue #255 (no invented number)', () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop },
    });

    expect(screen.queryByTestId(`target-concurrency-cap-${LOCAL_KEY}`)).toBeNull();
  });

  it('with no concurrency map passed at all, a target that does report a cap still renders at 0/cap rather than throwing', () => {
    const targets: TargetListEntry[] = [
      {
        nodeId: 'node_1',
        targetId: 'local',
        label: 'This machine',
        kind: 'local',
        reachable: true,
        providers: ['claude'],
        maxConcurrentSessions: 4,
        maxConcurrentSessionsSource: 'default',
      },
    ];
    render(TargetStatusView, {
      props: { targets, loading: false, error: undefined, onRefresh: noop },
    });

    expect(screen.getByTestId(`target-concurrency-cap-${LOCAL_KEY}`).textContent).toBe('0/4');
  });
});

describe('TargetStatusView identity conflict (issue #933)', () => {
  const IDENTITY_CONFLICT_TARGETS: TargetListEntry[] = [
    {
      nodeId: 'node_quiet',
      targetId: 'local',
      label: 'Quiet node',
      kind: 'local',
      reachable: true,
      providers: ['claude'],
      // No `identityConflict` at all — the overwhelming majority case,
      // exactly like `nodeSelfUpdate`'s own "never checked" fixture above.
    },
    {
      nodeId: 'node_fought_over',
      targetId: 'local',
      label: 'Contested node',
      kind: 'local',
      reachable: true,
      providers: ['claude'],
      identityConflict: {
        rivalDeviceId: 'device-rival-1',
        detectedAt: Date.UTC(2026, 6, 23, 12, 0, 0),
      },
    },
  ];

  it('shows an "Identity conflict" badge only for a node the relay just fought over, silent for every other row', () => {
    render(TargetStatusView, {
      props: {
        targets: IDENTITY_CONFLICT_TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
      },
    });
    expect(screen.queryByTestId('target-identity-conflict-node_quiet:local')).toBeNull();
    expect(
      screen.getByTestId('target-identity-conflict-node_fought_over:local').textContent?.trim(),
    ).toBe('Identity conflict');
  });

  it('names the rival device and when it was rejected once the row is expanded, and shows nothing for a quiet row', async () => {
    render(TargetStatusView, {
      props: {
        targets: IDENTITY_CONFLICT_TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
      },
    });

    await expandRow('node_quiet:local');
    expect(screen.queryByTestId('target-identity-conflict-detail-node_quiet:local')).toBeNull();

    await expandRow('node_fought_over:local');
    const detail = screen.getByTestId('target-identity-conflict-detail-node_fought_over:local');
    expect(detail.textContent).toContain('device-rival-1');
  });
});
