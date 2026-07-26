// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionInboxItem } from '$lib/relay-client';
import InboxPage from './InboxPage.svelte';

afterEach(() => cleanup());

const item: AttentionInboxItem = {
  kind: 'awaiting_input',
  sessionId: 'sess-a',
  sessionTitle: 'Fix the bug',
  projectPath: '/proj-a',
  nodeId: 'node-a',
  waitingSince: 1,
};

describe('InboxPage (design spec v4 §3.3, issue #507)', () => {
  it('renders a real page title and the AttentionInbox panel it wraps', () => {
    render(InboxPage, {
      props: { items: [item], onResolve: vi.fn(), onOpenSession: vi.fn(), onReply: vi.fn() },
    });

    expect(screen.getByRole('heading', { name: 'Inbox', level: 1 })).toBeTruthy();
    expect(screen.getByTestId('attention-inbox')).toBeTruthy();
    expect(screen.getByText('Fix the bug')).toBeTruthy();
  });

  it('has no close button: a page is left by navigating elsewhere, not by dismissing it', () => {
    render(InboxPage, {
      props: { items: [item], onResolve: vi.fn(), onOpenSession: vi.fn(), onReply: vi.fn() },
    });

    expect(screen.queryByTestId('drawer-close')).toBeNull();
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });

  it('reads nothing waiting as a good outcome (the shared EmptyState), not a blank rectangle', () => {
    render(InboxPage, {
      props: { items: [], onResolve: vi.fn(), onOpenSession: vi.fn(), onReply: vi.fn() },
    });

    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
    expect(screen.getByText('Nothing needs your attention.')).toBeTruthy();
  });
});
