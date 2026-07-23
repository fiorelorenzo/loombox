// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetListEntry } from '$lib/relay-client';
import TargetStatusView from './TargetStatusView.svelte';

afterEach(() => cleanup());

const HEALTHY = {
  cpuPercent: 40,
  memPercent: 60,
  memUsedBytes: 6_000_000_000,
  memTotalBytes: 10_000_000_000,
  diskPercent: 30,
  diskUsedBytes: 30_000_000_000,
  diskTotalBytes: 100_000_000_000,
  healthy: true,
  sampledAt: Date.UTC(2026, 6, 23, 12, 0, 0),
};

const TARGETS: TargetListEntry[] = [
  {
    nodeId: 'node_1',
    targetId: 'local',
    label: 'This machine',
    kind: 'local',
    reachable: true,
    health: HEALTHY,
  },
  {
    nodeId: 'node_1',
    targetId: 'ssh_devbox',
    label: 'devbox',
    kind: 'ssh',
    reachable: true,
    // No health sample yet.
  },
  {
    nodeId: 'node_2',
    targetId: 'ssh_flaky',
    label: 'flaky box',
    kind: 'ssh',
    reachable: true,
    health: { ...HEALTHY, healthy: false, cpuPercent: 0, memPercent: 0, diskPercent: 0 },
  },
  {
    nodeId: 'node_3',
    targetId: 'ssh_offline',
    label: 'offline box',
    kind: 'ssh',
    reachable: false,
  },
];

const noop = () => {};

describe('TargetStatusView (issue #269)', () => {
  it('lists every target with its label, kind, and node id', () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop, onClose: noop },
    });

    const rows = screen.getAllByTestId('target-status-row');
    expect(rows).toHaveLength(4);
    expect(screen.getByText('This machine')).toBeTruthy();
    expect(screen.getByText('devbox')).toBeTruthy();
    expect(screen.getByText('flaky box')).toBeTruthy();
    expect(screen.getByText('offline box')).toBeTruthy();
  });

  it('shows CPU/RAM/disk percentages for a target with a health reading', () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop, onClose: noop },
    });

    const row = screen.getByTestId('target-status-row-node_1:local');
    expect(row.textContent).toContain('40%');
    expect(row.textContent).toContain('60%');
    expect(row.textContent).toContain('30%');
  });

  it("shows 'No data yet' for a target that hasn't reported a health sample", () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop, onClose: noop },
    });

    const row = screen.getByTestId('target-status-row-node_1:ssh_devbox');
    expect(row.textContent).toContain('No data yet');
  });

  it('marks a target reachable but failing its own sample as unhealthy, distinct from a node-offline target', () => {
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop, onClose: noop },
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
        kind: 'local',
        reachable: true,
        health: { ...HEALTHY, cpuPercent: 96, healthy: true },
      },
    ];
    render(TargetStatusView, {
      props: {
        targets: overloaded,
        loading: false,
        error: undefined,
        onRefresh: noop,
        onClose: noop,
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
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh, onClose: noop },
    });

    await fireEvent.click(screen.getByTestId('target-status-refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(TargetStatusView, {
      props: { targets: TARGETS, loading: false, error: undefined, onRefresh: noop, onClose },
    });

    await fireEvent.click(screen.getByTestId('target-status-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a loading indicator while the first fetch is in flight', () => {
    render(TargetStatusView, {
      props: { targets: [], loading: true, error: undefined, onRefresh: noop, onClose: noop },
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
        onClose: noop,
      },
    });
    expect(screen.getByText(/timed out waiting for target_list/)).toBeTruthy();
  });

  it('shows a fallback message when there are no known targets', () => {
    render(TargetStatusView, {
      props: { targets: [], loading: false, error: undefined, onRefresh: noop, onClose: noop },
    });
    expect(screen.queryAllByTestId('target-status-row')).toHaveLength(0);
    expect(screen.getByText(/no nodes\/targets/i)).toBeTruthy();
  });

  it('highlights the row matching focusTarget (issue #269: a stalled session links back to its target)', () => {
    render(TargetStatusView, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        onClose: noop,
        focusTarget: { nodeId: 'node_2', targetId: 'ssh_flaky' },
      },
    });

    const flaky = screen.getByTestId('target-status-row-node_2:ssh_flaky');
    expect(flaky.className).toContain('focused');
    const other = screen.getByTestId('target-status-row-node_1:local');
    expect(other.className).not.toContain('focused');
  });
});
