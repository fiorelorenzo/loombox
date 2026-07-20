// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionInboxItem } from '../relay-client';
import AttentionInbox from './AttentionInbox.svelte';

afterEach(() => cleanup());

const PERMISSION_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const },
];

const permissionItem: AttentionInboxItem = {
  kind: 'permission',
  sessionId: 'sess-a',
  sessionTitle: 'Fix the bug',
  projectPath: '/proj-a',
  nodeId: 'node-a',
  waitingSince: 1,
  permission: {
    requestId: 'req-1',
    sessionId: 'sess-a',
    toolCall: { kind: 'tool_call', id: 'tc-1', title: 'Run tests' },
    options: PERMISSION_OPTIONS,
    parentToolCallId: undefined,
    enqueuedAt: 1,
  },
};

const awaitingInputItem: AttentionInboxItem = {
  kind: 'awaiting_input',
  sessionId: 'sess-b',
  sessionTitle: 'Add feature',
  projectPath: '/proj-b',
  nodeId: 'node-b',
  waitingSince: 0,
};

const finishedItem: AttentionInboxItem = {
  kind: 'session_outcome',
  sessionId: 'sess-c',
  sessionTitle: 'Refactor module',
  projectPath: '/proj-c',
  nodeId: 'node-c',
  waitingSince: 2,
  outcome: 'exited',
  stopReason: 'end_turn',
};

const erroredItem: AttentionInboxItem = {
  kind: 'session_outcome',
  sessionId: 'sess-d',
  sessionTitle: 'Migrate DB',
  projectPath: '/proj-d',
  nodeId: 'node-d',
  waitingSince: 3,
  outcome: 'error',
};

const ciFailureItem: AttentionInboxItem = {
  kind: 'ci_failure',
  sessionId: 'sess-e',
  sessionTitle: 'Add CI job',
  projectPath: '/proj-e',
  nodeId: 'node-e',
  waitingSince: 4,
};

const reviewRequestItem: AttentionInboxItem = {
  kind: 'review_request',
  sessionId: 'sess-f',
  sessionTitle: 'Open PR',
  projectPath: '/proj-f',
  nodeId: 'node-f',
  waitingSince: 5,
};

describe('AttentionInbox: empty state', () => {
  it('shows an empty-state message and no items when there is nothing to surface', () => {
    render(AttentionInbox, {
      props: { items: [], onResolve: vi.fn(), onOpenSession: vi.fn(), onReply: vi.fn() },
    });
    expect(screen.getByText('Nothing needs your attention.')).toBeTruthy();
    expect(screen.queryAllByTestId('attention-inbox-item')).toHaveLength(0);
  });
});

describe('AttentionInbox: rendering (issue #167)', () => {
  it('renders one row per item, in the given order, each showing the session title, project, and what it needs', () => {
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem, permissionItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows).toHaveLength(2);

    expect(within(rows[0]).getByText('Add feature')).toBeTruthy();
    expect(within(rows[0]).getByText('/proj-b · node-b')).toBeTruthy();
    expect(within(rows[0]).getByText('Waiting for your reply')).toBeTruthy();

    expect(within(rows[1]).getByText('Fix the bug')).toBeTruthy();
    expect(within(rows[1]).getByText('/proj-a · node-a')).toBeTruthy();
    expect(within(rows[1]).getByText('Needs approval: Run tests')).toBeTruthy();
  });

  it('renders a permission item with its actionable PermissionCard (issue #168), but no card for an awaiting_input item', () => {
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem, permissionItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    expect(screen.getAllByTestId('permission-card')).toHaveLength(1);
  });
});

describe('AttentionInbox: inline actions (issue #168)', () => {
  it('calls onResolve with the session id, request id, and chosen option when a permission item is approved', async () => {
    const onResolve = vi.fn();
    render(AttentionInbox, {
      props: { items: [permissionItem], onResolve, onOpenSession: vi.fn(), onReply: vi.fn() },
    });
    await fireEvent.click(screen.getByRole('button', { name: /Allow/ }));
    expect(onResolve).toHaveBeenCalledWith('sess-a', 'req-1', PERMISSION_OPTIONS[0]);
  });

  it('calls onOpenSession with the item session id when its Open control is pressed', async () => {
    const onOpenSession = vi.fn();
    render(AttentionInbox, {
      props: { items: [awaitingInputItem], onResolve: vi.fn(), onOpenSession, onReply: vi.fn() },
    });
    await fireEvent.click(screen.getByTestId('attention-inbox-open'));
    expect(onOpenSession).toHaveBeenCalledWith('sess-b');
  });

  it('shows an inline reply composer only for an awaiting_input item, not a permission item', () => {
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem, permissionItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    expect(screen.getAllByTestId('attention-inbox-reply')).toHaveLength(1);
  });

  it('calls onReply with the session id and typed text when the reply composer is submitted, then clears the input', async () => {
    const onReply = vi.fn();
    render(AttentionInbox, {
      props: { items: [awaitingInputItem], onResolve: vi.fn(), onOpenSession: vi.fn(), onReply },
    });
    const input = screen.getByTestId('attention-inbox-reply-input');
    await fireEvent.input(input, { target: { value: 'go ahead and merge it' } });
    await fireEvent.click(screen.getByTestId('attention-inbox-reply-send'));
    expect(onReply).toHaveBeenCalledWith('sess-b', 'go ahead and merge it');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('does not call onReply when the composer is submitted empty', async () => {
    const onReply = vi.fn();
    render(AttentionInbox, {
      props: { items: [awaitingInputItem], onResolve: vi.fn(), onOpenSession: vi.fn(), onReply },
    });
    await fireEvent.click(screen.getByTestId('attention-inbox-reply-send'));
    expect(onReply).not.toHaveBeenCalled();
  });
});

describe('AttentionInbox: session-outcome class (issue #167, SPEC §7.13)', () => {
  it('renders a finished session distinctly from an errored one, neither with a permission card or reply composer', () => {
    render(AttentionInbox, {
      props: {
        items: [finishedItem, erroredItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows).toHaveLength(2);

    expect(rows[0].dataset.kind).toBe('session_outcome');
    expect(within(rows[0]).getByText('Finished: end_turn')).toBeTruthy();
    expect(within(rows[0]).getByTestId('attention-inbox-kind-badge').textContent).toBe('Finished');

    expect(rows[1].dataset.kind).toBe('session_outcome');
    expect(within(rows[1]).getByTestId('attention-inbox-need').textContent).toBe('Errored');
    expect(within(rows[1]).getByTestId('attention-inbox-kind-badge').textContent).toBe('Errored');

    expect(screen.queryAllByTestId('permission-card')).toHaveLength(0);
    expect(screen.queryAllByTestId('attention-inbox-reply')).toHaveLength(0);
  });

  it('lets Open jump to the originating session from a session-outcome row', async () => {
    const onOpenSession = vi.fn();
    render(AttentionInbox, {
      props: { items: [erroredItem], onResolve: vi.fn(), onOpenSession, onReply: vi.fn() },
    });
    await fireEvent.click(screen.getByTestId('attention-inbox-open'));
    expect(onOpenSession).toHaveBeenCalledWith('sess-d');
  });
});

describe('AttentionInbox: CI-failure and review-request classes are modeled extension points (issue #167, v2-blocked)', () => {
  it('renders both classes with their own badge and needs-attention label, and an Open action, with no permission card or reply composer', async () => {
    const onOpenSession = vi.fn();
    render(AttentionInbox, {
      props: {
        items: [ciFailureItem, reviewRequestItem],
        onResolve: vi.fn(),
        onOpenSession,
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows).toHaveLength(2);

    expect(rows[0].dataset.kind).toBe('ci_failure');
    expect(within(rows[0]).getByTestId('attention-inbox-kind-badge').textContent).toBe('CI');
    expect(within(rows[0]).getByText('CI check failed')).toBeTruthy();

    expect(rows[1].dataset.kind).toBe('review_request');
    expect(within(rows[1]).getByTestId('attention-inbox-kind-badge').textContent).toBe('Review');
    expect(within(rows[1]).getByText('Review requested')).toBeTruthy();

    expect(screen.queryAllByTestId('permission-card')).toHaveLength(0);
    expect(screen.queryAllByTestId('attention-inbox-reply')).toHaveLength(0);

    await fireEvent.click(within(rows[0]).getByTestId('attention-inbox-open'));
    expect(onOpenSession).toHaveBeenCalledWith('sess-e');
  });
});

describe('AttentionInbox: all four classes are visually distinguishable (issue #167 acceptance)', () => {
  it('gives every class its own data-kind and its own badge text, not shared across classes', () => {
    render(AttentionInbox, {
      props: {
        items: [permissionItem, awaitingInputItem, finishedItem, ciFailureItem, reviewRequestItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    const kinds = rows.map((row) => row.dataset.kind);
    expect(new Set(kinds).size).toBe(kinds.length);

    const badges = screen
      .getAllByTestId('attention-inbox-kind-badge')
      .map((badge) => badge.textContent);
    expect(new Set(badges).size).toBe(badges.length);
  });
});
