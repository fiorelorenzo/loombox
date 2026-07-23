// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptMessageItem } from '@loombox/providers-core';
import MessageItem from './MessageItem.svelte';

afterEach(() => cleanup());

function messageItem(extra: Partial<TranscriptMessageItem> = {}): TranscriptMessageItem {
  return {
    type: 'message',
    id: 't1::agent_message_chunk::m1',
    kind: 'agent_message_chunk',
    turnId: 't1',
    messageId: 'm1',
    text: 'Hello there',
    ...extra,
  };
}

describe('MessageItem', () => {
  it('renders an agent message with its text visible', () => {
    render(MessageItem, { props: { item: messageItem() } });
    expect(screen.getByText('agent')).toBeTruthy();
    expect(screen.getByText('Hello there')).toBeTruthy();
  });

  it('renders a user message distinctly', () => {
    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });
    expect(screen.getByText('user')).toBeTruthy();
  });

  it('collapses a thought by default, expandable on tap', async () => {
    render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }) },
    });
    expect(screen.getByText('thought')).toBeTruthy();
    expect(screen.queryByText('secret reasoning')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Show thought' }));
    expect(screen.getByText('secret reasoning')).toBeTruthy();
  });

  it('has a working copy affordance', () => {
    render(MessageItem, { props: { item: messageItem() } });
    expect(screen.getByRole('button', { name: 'Copy agent message' })).toBeTruthy();
  });
});

describe('MessageItem: thinking/reasoning display (#136)', () => {
  afterEach(() => vi.useRealTimers());

  it('shows a live ticking "Thinking Ns" header that actually advances while thinking=true', async () => {
    vi.useFakeTimers();
    render(MessageItem, {
      props: {
        item: messageItem({ kind: 'agent_thought_chunk', text: 'reasoning...' }),
        thinking: true,
      },
    });
    const early = screen.getByTestId('thinking-timer').textContent;

    // `advanceTimersByTimeAsync` (not the sync variant) yields a microtask
    // between each fired interval tick, letting Svelte's own DOM-update
    // scheduling actually flush — the sync variant advances the clock and
    // runs every timer callback's *state write* but never gives the runtime
    // a chance to apply the resulting DOM update before the next assertion.
    await vi.advanceTimersByTimeAsync(3000);

    const later = screen.getByTestId('thinking-timer').textContent ?? '';
    expect(later).toMatch(/^Thinking \d+s$/);
    // Genuinely ticking, not stuck at whatever the first synchronous tick produced.
    expect(later).not.toBe(early);
  });

  it('shows the woven-thread motif (issue #274) while thinking, dropped once settled', async () => {
    vi.useFakeTimers();
    const { rerender } = render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk' }), thinking: true },
    });
    expect(screen.getByTestId('woven-loader')).toBeTruthy();

    await rerender({ item: messageItem({ kind: 'agent_thought_chunk' }), thinking: false });
    expect(screen.queryByTestId('woven-loader')).toBeNull();
  });

  it('settles to a static "Thought for Ns" the instant thinking flips false, and never ticks again', async () => {
    vi.useFakeTimers();
    const { rerender } = render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk' }), thinking: true },
    });
    await vi.advanceTimersByTimeAsync(2000);

    await rerender({ item: messageItem({ kind: 'agent_thought_chunk' }), thinking: false });
    expect(screen.getByTestId('thinking-timer').textContent).toMatch(/^Thought for \d+s$/);
    const settled = screen.getByTestId('thinking-timer').textContent;

    await vi.advanceTimersByTimeAsync(5000);
    expect(screen.getByTestId('thinking-timer').textContent).toBe(settled);
  });

  it('thought content is collapsed by default post-turn and expandable, distinct/muted from normal output', async () => {
    render(MessageItem, {
      props: {
        item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }),
        thinking: false,
      },
    });
    expect(screen.queryByTestId('thought-body')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Show thought' }));
    expect(screen.getByTestId('thought-body').textContent).toBe('secret reasoning');
  });

  it('reasoning display never delays or blocks the message content rendering behind it', () => {
    render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_message_chunk', text: 'answer' }), thinking: true },
    });
    // `thinking` only ever affects a 'thought'-role item; an agent message
    // renders its text unconditionally, immediately, regardless of it.
    expect(screen.getByText('answer')).toBeTruthy();
    expect(screen.queryByTestId('thinking-timer')).toBeNull();
  });
});

describe('MessageItem: streaming render pacing (#137)', () => {
  afterEach(() => vi.useRealTimers());

  it('renders replayed/settled history (turnActive omitted) in full immediately, never "typed out"', () => {
    render(MessageItem, { props: { item: messageItem({ text: 'a full historical message' }) } });
    expect(screen.getByTestId('message-text').textContent).toBe('a full historical message');
  });

  it('reveals a live item incrementally rather than dumping the whole burst at once, and never drops content', async () => {
    vi.useFakeTimers();
    const { getByTestId, rerender } = render(MessageItem, {
      props: { item: messageItem({ text: '' }), turnActive: true },
    });

    const longBurst = 'x'.repeat(400);
    await rerender({ item: messageItem({ text: longBurst }), turnActive: true });
    await vi.advanceTimersByTimeAsync(32);

    const midway = getByTestId('message-text').textContent ?? '';
    expect(midway.length).toBeGreaterThan(0);
    expect(midway.length).toBeLessThan(longBurst.length);
    expect(longBurst.startsWith(midway)).toBe(true);

    await vi.advanceTimersByTimeAsync(32 * 200);
    expect(getByTestId('message-text').textContent).toBe(longBurst);
  });

  it('flushes fully the instant turnActive goes false (the turn_ended guarantee)', async () => {
    vi.useFakeTimers();
    const longText = 'y'.repeat(300);
    const { getByTestId, rerender } = render(MessageItem, {
      props: { item: messageItem({ text: longText }), turnActive: true },
    });
    await vi.advanceTimersByTimeAsync(32); // still mid-reveal

    await rerender({ item: messageItem({ text: longText }), turnActive: false });
    expect(getByTestId('message-text').textContent).toBe(longText);
  });

  it('a mid-stream rerender does not remount the item — the DOM node stays the same instance across ticks', async () => {
    vi.useFakeTimers();
    const item = messageItem({ text: '' });
    const { getByTestId, rerender } = render(MessageItem, { props: { item, turnActive: true } });
    const before = getByTestId('message-item');

    await rerender({ item: { ...item, text: 'growing text' }, turnActive: true });
    await vi.advanceTimersByTimeAsync(32);
    const after = getByTestId('message-item');

    expect(after).toBe(before);
  });
});
