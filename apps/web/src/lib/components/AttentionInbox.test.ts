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
  waitingSince: 0,
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
    expect(within(rows[0]).getByText('/proj-b')).toBeTruthy();
    expect(within(rows[0]).getByText('Waiting for your reply')).toBeTruthy();

    expect(within(rows[1]).getByText('Fix the bug')).toBeTruthy();
    expect(within(rows[1]).getByText('/proj-a')).toBeTruthy();
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
