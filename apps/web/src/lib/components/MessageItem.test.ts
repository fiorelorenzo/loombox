// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptMessageItem } from '@loombox/providers-core/browser';
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
    // No providerId passed: falls back to the generic "Agent" label rather
    // than the raw role word (design spec v5 §4).
    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.getByText('Hello there')).toBeTruthy();
  });

  it("renders an agent message under the session's own provider name when one is given", () => {
    render(MessageItem, { props: { item: messageItem(), providerId: 'claude' } });
    expect(screen.getByText('Claude')).toBeTruthy();
  });

  it('renders a user message distinctly, labelled "You"', () => {
    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });
    expect(screen.getByText('You')).toBeTruthy();
  });

  it('collapses a thought by default, expandable on tap', async () => {
    render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }) },
    });
    // A thought is still the agent speaking (§4's gutter word doesn't gain
    // a third value) — "Thought for" already carries the aside itself.
    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.queryByText('secret reasoning')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Show thought' }));
    expect(screen.getByText('secret reasoning')).toBeTruthy();
  });

  it('has a working copy affordance', () => {
    render(MessageItem, { props: { item: messageItem() } });
    expect(screen.getByRole('button', { name: 'Copy agent message' })).toBeTruthy();
  });

  it('draws the "Show thought" disclosure chevron via the shared Icon component (#468)', () => {
    render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }) },
    });
    const button = screen.getByRole('button', { name: 'Show thought' });
    const icon = button.querySelector('[data-icon-name="collapse-chevron"]');
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
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

describe('MessageItem: one timeline metaphor (redesign v3 §3.4)', () => {
  it('renders a user message with the same structural shape as an agent message — a gutter plus content, never a bubble', () => {
    render(MessageItem, { props: { item: messageItem() } });
    const agentRoot = screen.getByTestId('message-item');
    const agentShape = Array.from(agentRoot.children).map((el) => el.tagName);
    const agentClasses = agentRoot.className.split(' ').filter((c) => c !== 'agent');
    cleanup();

    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });
    const userRoot = screen.getByTestId('message-item');
    const userShape = Array.from(userRoot.children).map((el) => el.tagName);
    const userClasses = userRoot.className.split(' ').filter((c) => c !== 'user');

    // Identical DOM shape (gutter + content), not a right-aligned bubble
    // for one role and a full-width card for the other.
    expect(userShape).toEqual(agentShape);
    expect(userRoot.querySelector('.gutter')).toBeTruthy();
    expect(userRoot.querySelector('.content')).toBeTruthy();
    // The only class difference between the two roots is the role modifier.
    expect(userClasses.sort()).toEqual(agentClasses.sort());
  });

  it('never renders the raw USER/AGENT/THOUGHT role word in the visible content flow — the gutter carries a friendly label instead', () => {
    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });
    const content = document.querySelector('.content');
    expect(content?.textContent ?? '').not.toMatch(/\b(USER|AGENT|THOUGHT)\b/i);
  });
});

describe('MessageItem: every turn states its role (design spec v5 §4)', () => {
  it('tells a user turn from an agent turn by a real, visible, accessible role-label word in the gutter', () => {
    render(MessageItem, { props: { item: messageItem() } });
    const agentLabel = screen.getByText('Agent');
    expect(agentLabel.getAttribute('aria-hidden')).not.toBe('true');
    cleanup();

    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });
    const userLabel = screen.getByText('You');
    expect(userLabel.getAttribute('aria-hidden')).not.toBe('true');
    // Different, real words — not the same node re-styled by colour alone.
    expect(userLabel.textContent).not.toBe(agentLabel.textContent);
  });

  it('puts no decorative mark in that gutter beside the word', () => {
    // Every turn used to carry a 4px dot above the label: `--color-text-muted`
    // for an agent, accent for the user. Right-aligned, it landed over the
    // label's last letter and read as dirt on the screen; muted, it said
    // nothing an agent turn did not already say. The accent moved onto the word
    // itself, so the cue survives and the speck does not.
    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });

    const gutter = document.querySelector('.gutter');
    expect(gutter).toBeTruthy();
    expect(gutter?.children).toHaveLength(1);
    expect(gutter?.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("labels an agent turn with the session's own provider name, not a generic word, when one is known", () => {
    render(MessageItem, { props: { item: messageItem(), providerId: 'codex' } });
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.queryByText('Agent')).toBeNull();
  });

  it("puts the user's own turn on a raised surface, on top of (never instead of) the label", () => {
    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });
    expect(screen.getByTestId('message-item').className).toMatch(/\buser\b/);
    expect(screen.getByText('You')).toBeTruthy();
  });
});
