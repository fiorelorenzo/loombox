// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
import type { ToolCallBurstGroupItem } from '$lib/transcript/tool-call-bursts';
import ToolCallBurstGroup from './ToolCallBurstGroup.svelte';

afterEach(() => cleanup());

function toolCallItem(
  id: string,
  extra: Partial<TranscriptToolCallItem> = {},
): TranscriptToolCallItem {
  return {
    type: 'tool_call',
    id,
    turnId: 't1',
    title: `tool ${id}`,
    toolKind: 'execute',
    status: 'completed',
    diff: undefined,
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
    ...extra,
  };
}

function group(
  calls: readonly TranscriptToolCallItem[],
  extra: Partial<ToolCallBurstGroupItem> = {},
): ToolCallBurstGroupItem {
  return {
    type: 'tool_call_group',
    id: `tool_call_group::${calls[0]!.id}`,
    calls,
    depth: 0,
    parentTitle: undefined,
    ...extra,
  };
}

describe('ToolCallBurstGroup: collapsed summary line', () => {
  it('shows the call count, a succeeded/failed breakdown, and starts collapsed', () => {
    const calls = [
      toolCallItem('a', { status: 'completed' }),
      toolCallItem('b', { status: 'completed' }),
      toolCallItem('c', { status: 'failed' }),
    ];
    render(ToolCallBurstGroup, {
      props: { group: group(calls), awaitingPermissionId: undefined, forceExpandItemId: undefined },
    });
    expect(screen.getByText('3 tool calls')).toBeTruthy();
    expect(screen.getByText(/2 succeeded/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(screen.queryByTestId('tool-call-burst-detail')).toBeNull();
  });

  it('a zero-count status bucket never appears in the summary line — no "0 failed" noise', () => {
    const calls = [toolCallItem('a'), toolCallItem('b'), toolCallItem('c')];
    render(ToolCallBurstGroup, {
      props: { group: group(calls), awaitingPermissionId: undefined, forceExpandItemId: undefined },
    });
    expect(screen.getByText('3 succeeded')).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();
    expect(screen.queryByText(/running/)).toBeNull();
    expect(screen.queryByText(/pending/)).toBeNull();
  });

  it('sums elapsed time honestly — only the calls with a known duration, never a fabricated total', () => {
    const calls = [
      toolCallItem('a', { elapsedMs: 200 }),
      toolCallItem('b', { elapsedMs: 800 }),
      toolCallItem('c'), // unknown duration — excluded, not treated as 0
    ];
    render(ToolCallBurstGroup, {
      props: { group: group(calls), awaitingPermissionId: undefined, forceExpandItemId: undefined },
    });
    expect(screen.getByText(/1\.0s/)).toBeTruthy();
  });

  it('shows no elapsed figure at all when NONE of the calls have a known duration', () => {
    const calls = [toolCallItem('a'), toolCallItem('b')];
    render(ToolCallBurstGroup, {
      props: { group: group(calls), awaitingPermissionId: undefined, forceExpandItemId: undefined },
    });
    const summaryText = screen.getByTestId('tool-call-burst-summary').textContent ?? '';
    expect(summaryText).not.toContain('·');
    expect(summaryText).not.toMatch(/\d+(\.\d)?s\b/);
  });

  it('a failed call in the run is the loudest signal — the status dot goes danger regardless of how many succeeded', () => {
    const calls = [toolCallItem('a'), toolCallItem('b'), toolCallItem('c', { status: 'failed' })];
    render(ToolCallBurstGroup, {
      props: { group: group(calls), awaitingPermissionId: undefined, forceExpandItemId: undefined },
    });
    expect(screen.getByTestId('ui-status-dot').dataset.tone).toBe('danger');
  });

  it('a still-running call (no failure yet) shows the "info" tone with a live pulse', () => {
    const calls = [toolCallItem('a'), toolCallItem('b', { status: 'in_progress' })];
    render(ToolCallBurstGroup, {
      props: { group: group(calls), awaitingPermissionId: undefined, forceExpandItemId: undefined },
    });
    const dot = screen.getByTestId('ui-status-dot');
    expect(dot.dataset.tone).toBe('info');
    expect(dot.dataset.pulse).toBe('true');
  });

  it('every call settled clean shows the "success" tone with no pulse', () => {
    const calls = [toolCallItem('a'), toolCallItem('b')];
    render(ToolCallBurstGroup, {
      props: { group: group(calls), awaitingPermissionId: undefined, forceExpandItemId: undefined },
    });
    const dot = screen.getByTestId('ui-status-dot');
    expect(dot.dataset.tone).toBe('success');
    expect(dot.dataset.pulse).toBe('false');
  });
});

describe('ToolCallBurstGroup: expand/collapse', () => {
  it('clicking the summary reveals every real call through ToolCallRow, and clicking again hides them', async () => {
    const calls = [toolCallItem('a'), toolCallItem('b'), toolCallItem('c')];
    render(ToolCallBurstGroup, {
      props: { group: group(calls), awaitingPermissionId: undefined, forceExpandItemId: undefined },
    });
    const toggle = screen.getByTestId('tool-call-burst-summary');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const detail = screen.getByTestId('tool-call-burst-detail');
    expect(within(detail).getAllByTestId('tool-call-row')).toHaveLength(3);
    expect(detail.querySelector('[data-item-id="a"]')).toBeTruthy();
    expect(detail.querySelector('[data-item-id="b"]')).toBeTruthy();
    expect(detail.querySelector('[data-item-id="c"]')).toBeTruthy();

    await fireEvent.click(toggle);
    expect(screen.queryByTestId('tool-call-burst-detail')).toBeNull();
  });
});

describe('ToolCallBurstGroup: a pending permission stays reachable (mirrors ToolCallRow’s own awaiting-permission contract)', () => {
  it('forces the card open with no toggle affordance, and only the actionable child carries the awaiting-permission ring', () => {
    const calls = [toolCallItem('a'), toolCallItem('b'), toolCallItem('c')];
    render(ToolCallBurstGroup, {
      props: { group: group(calls), awaitingPermissionId: 'b', forceExpandItemId: undefined },
    });

    const summary = screen.getByTestId('tool-call-burst-summary');
    expect(summary.tagName).toBe('DIV');
    expect(summary.getAttribute('aria-expanded')).toBe('true');

    const detail = screen.getByTestId('tool-call-burst-detail');
    const rows = within(detail).getAllByTestId('tool-call-row');
    expect(rows).toHaveLength(3);
    const awaitingRow = detail.querySelector('[data-item-id="b"] [data-testid="tool-call-row"]');
    expect(awaitingRow?.className).toContain('awaiting-permission');
    const otherRow = detail.querySelector('[data-item-id="a"] [data-testid="tool-call-row"]');
    expect(otherRow?.className).not.toContain('awaiting-permission');
  });

  it('an awaitingPermissionId not present in this group leaves it collapsed, untouched', () => {
    const calls = [toolCallItem('a'), toolCallItem('b')];
    render(ToolCallBurstGroup, {
      props: {
        group: group(calls),
        awaitingPermissionId: 'somewhere-else',
        forceExpandItemId: undefined,
      },
    });
    expect(screen.queryByTestId('tool-call-burst-detail')).toBeNull();
    expect(screen.getByTestId('tool-call-burst-summary').tagName).toBe('BUTTON');
  });
});

describe('ToolCallBurstGroup: forceExpandItemId (jump-target / search-match interaction, issues #740 / #262 / #263)', () => {
  it('opens the card when the target is one of this group’s calls, but stays a real, dismissable toggle', async () => {
    const calls = [toolCallItem('a'), toolCallItem('b')];
    render(ToolCallBurstGroup, {
      props: { group: group(calls), awaitingPermissionId: undefined, forceExpandItemId: 'b' },
    });
    expect(screen.getByTestId('tool-call-burst-detail')).toBeTruthy();
    const toggle = screen.getByTestId('tool-call-burst-summary');
    expect(toggle.tagName).toBe('BUTTON');
  });

  it('a forceExpandItemId not present in this group does nothing', () => {
    const calls = [toolCallItem('a'), toolCallItem('b')];
    render(ToolCallBurstGroup, {
      props: {
        group: group(calls),
        awaitingPermissionId: undefined,
        forceExpandItemId: 'elsewhere',
      },
    });
    expect(screen.queryByTestId('tool-call-burst-detail')).toBeNull();
  });
});
