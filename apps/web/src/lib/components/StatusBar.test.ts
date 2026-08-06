// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageRecord } from '@loombox/providers-core/browser';
import type { SessionStatusV1 } from '@loombox/protocol';
import type { ConnectionStatus } from '$lib/relay-client';
import StatusBar, { type TargetHealthDotState } from './StatusBar.svelte';

afterEach(() => cleanup());

/** Every prop this component needs, defaulted to its quietest reading (open connection, no targets, no session, no spend) — each test overrides only what it's exercising. */
function baseProps(): {
  connectionStatus: ConnectionStatus;
  onRetryConnection: () => void;
  selectedSessionTargetLabel: string | undefined;
  targetHealthDots: { key: string; label: string; state: TargetHealthDotState }[];
  targetsBehindCount: number;
  onOpenNodes: () => void;
  hasSelectedSession: boolean;
  selectedSessionStatus: SessionStatusV1 | undefined;
  selectedSessionStatusReason: string | undefined;
  queuedSessionCount: number;
  usage: UsageRecord | undefined;
  cumulativeCostUsd: number;
} {
  return {
    connectionStatus: 'open',
    onRetryConnection: vi.fn(),
    selectedSessionTargetLabel: undefined,
    targetHealthDots: [],
    targetsBehindCount: 0,
    onOpenNodes: vi.fn(),
    hasSelectedSession: false,
    selectedSessionStatus: undefined,
    selectedSessionStatusReason: undefined,
    queuedSessionCount: 0,
    usage: undefined,
    cumulativeCostUsd: 0,
  };
}

const usageAt = (tokensUsed: number, attributedToSubagent = false): UsageRecord => ({
  sessionId: 's1',
  tokensUsed,
  contextWindow: 200_000,
  costUsd: 0.5,
  attributedToSubagent,
});

const ALL_SESSION_STATUSES: SessionStatusV1[] = [
  'queued',
  'starting',
  'working',
  'awaiting_input',
  'permission_required',
  'error',
  'exited',
  'disconnected',
  'paused',
];

describe('StatusBar: relay connection (left zone, issue #736)', () => {
  it('reads every connection state distinctly, including the healthy one (unlike the retired chip, which rendered nothing at all for it)', () => {
    const cases: [ConnectionStatus, string][] = [
      ['open', 'Connected'],
      ['connecting', 'Connecting…'],
      ['closed', 'Reconnecting…'],
      ['error', 'Offline'],
      ['idle', 'Not connected'],
    ];
    for (const [connectionStatus, label] of cases) {
      const { unmount } = render(StatusBar, {
        props: { ...baseProps(), connectionStatus },
      });
      expect(screen.getByTestId('status-bar-connection').textContent).toContain(label);
      unmount();
    }
  });

  it('shows Retry only for a state that can be retried, and clicking it calls onRetryConnection', async () => {
    const onRetryConnection = vi.fn();
    render(StatusBar, {
      props: { ...baseProps(), connectionStatus: 'error', onRetryConnection },
    });
    const retry = screen.getByTestId('status-bar-connection-retry');
    await fireEvent.click(retry);
    expect(onRetryConnection).toHaveBeenCalledOnce();
  });

  it('renders no Retry control while the connection is healthy or still connecting', () => {
    render(StatusBar, { props: { ...baseProps(), connectionStatus: 'open' } });
    expect(screen.queryByTestId('status-bar-connection-retry')).toBeNull();
  });
});

describe("StatusBar: selected session's own target (left zone, issue #738, B3-3)", () => {
  it('renders nothing when no session is selected', () => {
    render(StatusBar, { props: { ...baseProps(), selectedSessionTargetLabel: undefined } });
    expect(screen.queryByTestId('status-bar-session-target')).toBeNull();
  });

  it("renders the selected session's own target label, in mono (issue #735's structural-identifier rule)", () => {
    render(StatusBar, {
      props: { ...baseProps(), selectedSessionTargetLabel: 'MacBook-Pro-Lorenzo' },
    });
    const segment = screen.getByTestId('status-bar-session-target');
    expect(segment.textContent).toContain('MacBook-Pro-Lorenzo');
    expect(segment.innerHTML).toContain('font-mono');
  });
});

describe('StatusBar: target health and Behind (left zone, issue #736)', () => {
  it('reads "No targets" when the account has none yet', () => {
    render(StatusBar, { props: baseProps() });
    expect(screen.getByTestId('status-bar-targets').textContent).toContain('No targets');
  });

  it('summarizes every target as healthy when none are unreachable or overloaded', () => {
    render(StatusBar, {
      props: {
        ...baseProps(),
        targetHealthDots: [
          { key: 'a', label: 'a', state: 'healthy' },
          { key: 'b', label: 'b', state: 'healthy' },
        ],
      },
    });
    expect(screen.getByTestId('status-bar-targets').textContent).toContain('2 targets healthy');
  });

  it('leads with the unreachable count, outranking overloaded', () => {
    render(StatusBar, {
      props: {
        ...baseProps(),
        targetHealthDots: [
          { key: 'a', label: 'a', state: 'unreachable' },
          { key: 'b', label: 'b', state: 'overloaded' },
          { key: 'c', label: 'c', state: 'healthy' },
        ],
      },
    });
    expect(screen.getByTestId('status-bar-targets').textContent).toContain('1 of 3 unreachable');
  });

  it('clicking the target-health segment calls onOpenNodes', async () => {
    const onOpenNodes = vi.fn();
    render(StatusBar, {
      props: { ...baseProps(), onOpenNodes },
    });
    await fireEvent.click(screen.getByTestId('status-bar-targets'));
    expect(onOpenNodes).toHaveBeenCalledOnce();
  });

  it('renders no Behind badge when nothing is behind', () => {
    render(StatusBar, { props: baseProps() });
    expect(screen.queryByTestId('status-bar-behind')).toBeNull();
  });

  it('renders a Behind badge with the count, and it also opens Nodes settings', async () => {
    const onOpenNodes = vi.fn();
    render(StatusBar, {
      props: { ...baseProps(), targetsBehindCount: 2, onOpenNodes },
    });
    const behind = screen.getByTestId('status-bar-behind');
    expect(behind.textContent).toContain('2 behind');
    await fireEvent.click(behind);
    expect(onOpenNodes).toHaveBeenCalledOnce();
  });

  it('a single behind target reads the bare word, not "1 behind"', () => {
    render(StatusBar, {
      props: { ...baseProps(), targetsBehindCount: 1 },
    });
    expect(screen.getByTestId('status-bar-behind').textContent).toContain('Behind');
    expect(screen.getByTestId('status-bar-behind').textContent).not.toContain('1 behind');
  });
});

describe('StatusBar: session state (right zone, issue #736 acceptance)', () => {
  it('reads "No session selected" rather than a stale/unknown status when nothing is selected', () => {
    render(StatusBar, {
      props: { ...baseProps(), hasSelectedSession: false, selectedSessionStatus: undefined },
    });
    expect(screen.getByTestId('status-bar-session').textContent).toContain('No session selected');
  });

  it('renders every one of the eight SessionStatusV1 values distinctly', () => {
    const seen = new Set<string>();
    for (const status of ALL_SESSION_STATUSES) {
      const { unmount } = render(StatusBar, {
        props: { ...baseProps(), hasSelectedSession: true, selectedSessionStatus: status },
      });
      const text = screen.getByTestId('status-bar-session').textContent ?? '';
      expect(text.trim().length).toBeGreaterThan(0);
      expect(seen.has(text)).toBe(false);
      seen.add(text);
      unmount();
    }
    expect(seen.size).toBe(ALL_SESSION_STATUSES.length);
  });

  it("an error status's reason is folded into the label, same as the sidebar row's badge", () => {
    render(StatusBar, {
      props: {
        ...baseProps(),
        hasSelectedSession: true,
        selectedSessionStatus: 'error',
        selectedSessionStatusReason: 'spawn timed out',
      },
    });
    expect(screen.getByTestId('status-bar-session').textContent).toContain(
      'Error: spawn timed out',
    );
  });

  it('renders no queued-session count when nothing is queued', () => {
    render(StatusBar, { props: baseProps() });
    expect(screen.queryByTestId('status-bar-queued')).toBeNull();
  });

  it('renders the queued-session count when other sessions are waiting for a slot', () => {
    render(StatusBar, { props: { ...baseProps(), queuedSessionCount: 3 } });
    expect(screen.getByTestId('status-bar-queued').textContent).toContain('3 sessions queued');
  });
});

describe('StatusBar: context/cost meter (ported from ConfigBar, issue #248 correctness fixes)', () => {
  it('reports the context in use against its maximum, not a bare percentage', () => {
    render(StatusBar, {
      props: { ...baseProps(), usage: usageAt(50_000), cumulativeCostUsd: 1.23 },
    });
    expect(screen.getByText('50k')).toBeTruthy();
    expect(screen.getByText('200k')).toBeTruthy();
    expect(screen.getByText('$1.23')).toBeTruthy();
    expect(screen.getByTestId('context-meter').getAttribute('title')).toBe(
      '25% of the context window used this turn (50,000 of 200,000 tokens) · $1.23 spent this session',
    );
  });

  it('renders the token counts and the cost — numeric figures — in the shared mono identifier face (issue #735, ported from ConfigBar)', () => {
    const { container } = render(StatusBar, {
      props: { ...baseProps(), usage: usageAt(50_000), cumulativeCostUsd: 1.23 },
    });
    expect(container.querySelector('.meter-primary')?.className).toContain('font-mono');
    expect(container.querySelector('.meter-max')?.className).toContain('font-mono');
    expect(container.querySelector('.meter-cost')?.className).toContain('font-mono');
  });

  it('fills the track to the percentage used', () => {
    render(StatusBar, { props: { ...baseProps(), usage: usageAt(50_000) } });
    const track = screen.getByTestId('context-track');
    expect(track.dataset.fill).toBe('25');
    expect((track.firstElementChild as HTMLElement).style.width).toBe('25%');
  });

  it('warns at 80% of the window and escalates at 95%', () => {
    const { rerender } = render(StatusBar, {
      props: { ...baseProps(), usage: usageAt(100_000) },
    });
    expect(screen.getByTestId('context-track').className).not.toContain('high');

    rerender({ ...baseProps(), usage: usageAt(170_000) });
    expect(screen.getByTestId('context-track').className).toContain('high');
    expect(screen.getByTestId('context-track').className).not.toContain('full');

    rerender({ ...baseProps(), usage: usageAt(195_000) });
    expect(screen.getByTestId('context-track').className).toContain('full');
  });

  it('the near-limit warning fires at exactly the threshold, and not one percentage point before', () => {
    const { rerender } = render(StatusBar, {
      props: { ...baseProps(), usage: usageAt(158_000) },
    });
    expect(screen.getByTestId('context-track').dataset.fill).toBe('79');
    expect(screen.queryByTestId('context-warning')).toBeNull();

    rerender({ ...baseProps(), usage: usageAt(160_000) });
    expect(screen.getByTestId('context-track').dataset.fill).toBe('80');
    expect(screen.getByTestId('context-warning')).toBeTruthy();
    expect(screen.getByTestId('context-warning').textContent).toContain('80%');
  });

  it("renders the context figures regardless of attributedToSubagent — the reducer's job, not this component's", () => {
    render(StatusBar, {
      props: { ...baseProps(), usage: usageAt(50_000, true), cumulativeCostUsd: 1.23 },
    });
    expect(screen.getByTestId('context-track').dataset.fill).toBe('25');
    expect(screen.getByText('50k')).toBeTruthy();
    expect(screen.getByText('$1.23')).toBeTruthy();
  });

  it('says nothing about the context when the agent reported a used count with no window to measure it against', () => {
    render(StatusBar, {
      props: {
        ...baseProps(),
        usage: {
          sessionId: 's1',
          tokensUsed: 50_000,
          contextWindow: undefined,
          costUsd: 0.5,
          attributedToSubagent: false,
        },
        cumulativeCostUsd: 1.23,
      },
    });
    expect(screen.queryByTestId('context-track')).toBeNull();
    expect(screen.queryByText('50k')).toBeNull();
    expect(screen.getByText('$1.23')).toBeTruthy();
  });

  it('shows nothing but the cost when no session is selected at all, rather than stale figures from a previous session', () => {
    render(StatusBar, {
      props: { ...baseProps(), hasSelectedSession: false, usage: undefined, cumulativeCostUsd: 0 },
    });
    expect(screen.queryByTestId('context-track')).toBeNull();
    expect(screen.getByText('$0.00')).toBeTruthy();
  });
});
