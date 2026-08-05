// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptMessageItem } from '@loombox/providers-core/browser';
import { DEFAULT_EXPAND_THOUGHTS, expandThoughtsStore } from '$lib/expand-thoughts';
import MessageItem from './MessageItem.svelte';

afterEach(() => {
  cleanup();
  // B2-1 (issue #709) made `expanded` a module-level singleton shared by
  // every `MessageItem` instance — reset it after every test so one test's
  // toggle click can't bleed into the next test's "default" assumption
  // (same pattern as `theme.test.ts`/`accent.test.ts` for their own
  // module-level stores).
  expandThoughtsStore.setExpanded(DEFAULT_EXPAND_THOUGHTS);
  localStorage.clear();
});

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
    // No providerId passed: falls back to the generic "Agent" accessible
    // label rather than the raw role word (design spec v6 §3.4).
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

  it('expands a thought by default and collapses on tap (B2-1: "di default espanso", issue #709)', async () => {
    render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }) },
    });
    // A thought is still the agent speaking (the accessible label doesn't
    // gain a third value) — "Thought for" already carries the aside itself.
    expect(screen.getByText('Agent')).toBeTruthy();
    // The shared preference starts expanded, so the body is already
    // visible with no click at all.
    expect(screen.getByText('secret reasoning')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Collapse thought' }));
    expect(screen.queryByText('secret reasoning')).toBeNull();
  });

  it('has a working copy affordance', () => {
    render(MessageItem, { props: { item: messageItem() } });
    expect(screen.getByRole('button', { name: 'Copy agent message' })).toBeTruthy();
  });

  it("draws the thought disclosure chevron via the shared Icon component (#468), decorative behind the button's own aria-label", () => {
    render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }) },
    });
    // Icon-only since B2-1 (issue #709) moved the visible label above the
    // thought — the button's `aria-label` carries the name now, not text
    // beside the chevron.
    const button = screen.getByRole('button', { name: 'Collapse thought' });
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

  it('thought content follows an explicitly-collapsed preference post-turn and expands on tap (B2-1, issue #709)', async () => {
    expandThoughtsStore.setExpanded(false);
    render(MessageItem, {
      props: {
        item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }),
        thinking: false,
      },
    });
    expect(screen.queryByTestId('thought-body')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Expand thought' }));
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

  it('never renders the raw USER/AGENT/THOUGHT role word in the visible content flow — attribution lives in the gutter instead', () => {
    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });
    const content = document.querySelector('.content');
    expect(content?.textContent ?? '').not.toMatch(/\b(USER|AGENT|THOUGHT)\b/i);
  });
});

describe('MessageItem: turn delimitation v7 (design spec §2, issue #667 — B1-2 amended + B2-4)', () => {
  it('draws no glyph in the gutter for any role, provider, or grouping — the surface alone carries the distinction now', () => {
    const { container } = render(MessageItem, {
      props: { item: messageItem(), providerId: 'claude' },
    });
    expect(container.querySelector('[data-icon-name^="provider-"]')).toBeNull();
    cleanup();

    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });
    expect(document.querySelector('[data-icon-name^="provider-"]')).toBeNull();
  });

  it("still announces the session's own provider name — or falls back to 'Agent'/'You' — through the off-screen .sr-only label alone", () => {
    render(MessageItem, { props: { item: messageItem(), providerId: 'codex' } });
    const providerLabel = screen.getByText('Codex');
    expect(providerLabel.className).toContain('sr-only');
    expect(providerLabel.getAttribute('aria-hidden')).not.toBe('true');
    cleanup();

    render(MessageItem, { props: { item: messageItem() } });
    expect(screen.getByText('Agent').className).toContain('sr-only');
    cleanup();

    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });
    expect(screen.getByText('You').className).toContain('sr-only');
  });

  it('gives the user turn and the agent turn distinct role classes — the one signal each surface reads to tell them apart', () => {
    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });
    expect(screen.getByTestId('message-item').className).toMatch(/\buser\b/);
    cleanup();

    render(MessageItem, { props: { item: messageItem() } });
    expect(screen.getByTestId('message-item').className).toMatch(/\bagent\b/);
  });
});

describe('MessageItem: v8 §2 decisions (design spec 2026-08-05-cockpit-v8-decisions.md, issue #709)', () => {
  afterEach(() => vi.useRealTimers());

  it('B2-1: the disclosure toggle carries no visible text — the label moved above the thought, the accessible name lives in aria-label alone', () => {
    render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }) },
    });
    const button = screen.getByRole('button', { name: 'Collapse thought' });
    expect(button.textContent?.trim()).toBe('');
  });

  it('B2-1: one global switch — toggling the preference from ANY thought flips every currently-mounted thought, not just the one clicked', async () => {
    render(MessageItem, {
      props: { item: messageItem({ id: 'a', kind: 'agent_thought_chunk', text: 'first thought' }) },
    });
    // A second, independent render — `render()` appends its own container
    // to `document.body` rather than replacing the first, and `cleanup()`
    // only runs in `afterEach`, so both stay mounted side by side, same
    // as two thoughts in one real transcript.
    render(MessageItem, {
      props: {
        item: messageItem({ id: 'b', kind: 'agent_thought_chunk', text: 'second thought' }),
      },
    });

    // Both start expanded (the shared default).
    expect(screen.getByText('first thought')).toBeTruthy();
    expect(screen.getByText('second thought')).toBeTruthy();

    // Collapsing the FIRST thought's own toggle collapses the second one
    // too — proof it's one shared boolean, not two independent instances
    // of the old per-component `$state(false)`.
    const [firstToggle] = screen.getAllByRole('button', { name: 'Collapse thought' });
    await fireEvent.click(firstToggle);
    expect(screen.queryByText('first thought')).toBeNull();
    expect(screen.queryByText('second thought')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Expand thought' })).toHaveLength(2);
  });

  it('B2-1 x #660: a thought that is currently producing text stays visible and keeps growing even while the resting preference is collapsed', async () => {
    expandThoughtsStore.setExpanded(false);
    vi.useFakeTimers();
    const item = messageItem({ kind: 'agent_thought_chunk', text: '' });
    const { getByTestId, queryByTestId, rerender } = render(MessageItem, {
      props: { item, thinking: true, turnActive: true },
    });

    // Collapsed preference, but actively thinking: the body must already
    // be in the DOM with no click — this is the exact collapsed-container
    // collision #660 names (a thought streaming into a collapsed
    // container is why #660's own fake stayed green for months).
    expect(queryByTestId('thought-body')).toBeTruthy();

    const full = 'reasoning about the empty-table edge case in some detail';
    await rerender({ item: { ...item, text: full }, thinking: true, turnActive: true });
    await vi.advanceTimersByTimeAsync(32);
    const midway = getByTestId('thought-body').textContent ?? '';
    expect(midway.length).toBeGreaterThan(0);
    expect(midway.length).toBeLessThan(full.length);
    expect(full.startsWith(midway)).toBe(true);

    // Once thinking ends the override is one-directional: it collapses
    // right back to the still-collapsed shared preference, same as every
    // other thought.
    await rerender({ item: { ...item, text: full }, thinking: false, turnActive: false });
    expect(queryByTestId('thought-body')).toBeNull();
  });
});

describe('MessageItem: Markdown rendering (issue #574)', () => {
  afterEach(() => vi.useRealTimers());

  it('renders a fenced ts block as a code block with no visible backticks, plain first then highlighted (#600 async highlighter)', async () => {
    const { container } = render(MessageItem, {
      props: { item: messageItem({ text: '```ts\nconst x: number = 1;\n```' }) },
    });
    expect(screen.getByTestId('message-text').textContent).not.toContain('```');
    // The language class is present immediately (remark-rehype's own
    // fenced-code handling); the `hljs-*` token spans land once the
    // dynamically-imported grammar (issue #600) resolves.
    expect(container.querySelector('pre code.language-ts')).toBeTruthy();
    expect(container.querySelector('.hljs-keyword')).toBeNull();
    await vi.waitFor(() => {
      expect(container.querySelector('.hljs-keyword')).toBeTruthy();
    });
  });

  it('renders a nested markdown list with real <ul>/<li> markers and indentation, not literal dashes', () => {
    const { container } = render(MessageItem, {
      props: { item: messageItem({ text: '- a\n  - nested a1\n  - nested a2\n- b' }) },
    });
    expect(screen.getByTestId('message-text').textContent).not.toContain('- a');
    const lists = container.querySelectorAll('ul');
    expect(lists.length).toBe(2); // one outer, one nested
    expect(container.querySelectorAll('li').length).toBe(4);
    const outer = lists[0];
    expect(outer.querySelector('ul')).toBeTruthy(); // nested list is inside the outer li
  });

  it('wraps a wide table in a horizontally scrollable container instead of stretching the row', () => {
    const { container } = render(MessageItem, {
      props: { item: messageItem({ text: '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |' }) },
    });
    const wrap = container.querySelector('.md-table-scroll');
    expect(wrap).toBeTruthy();
    expect(wrap?.querySelector('table')).toBeTruthy();
    expect(wrap?.querySelectorAll('th').length).toBe(3);
  });

  it('renders a still-open fence as a plain, unhighlighted monospace box at several intermediate reveal states, then highlights it once closed with no flicker between two layouts', async () => {
    vi.useFakeTimers();
    const opening = 'Explain:\n\n```ts\nconst x: number = 1;\nconsole.lo';
    const item = messageItem({ text: opening });
    const { getByTestId, queryByTestId, rerender } = render(MessageItem, {
      props: { item, turnActive: true },
    });

    // Several intermediate reveal states while the fence is still open: it
    // always renders as the plain monospace box, never with token spans,
    // and never disappears.
    for (const advanceMs of [32, 64, 32 * 20]) {
      await vi.advanceTimersByTimeAsync(advanceMs);
      const openFence = queryByTestId('md-open-fence');
      if (openFence) {
        expect(openFence.querySelector('.hljs-keyword')).toBeNull();
        expect(openFence.tagName).toBe('PRE');
      }
    }
    await vi.advanceTimersByTimeAsync(32 * 200); // fully caught up to the (still-open) target
    const openFence = getByTestId('md-open-fence');
    expect(openFence.textContent).toContain('const x: number = 1;');
    expect(openFence.querySelector('.hljs-keyword')).toBeNull();

    // The fence closes and the turn ends (the real turn_ended signal): the
    // open box is gone immediately, replaced by the closed-but-plain
    // fence — one transition, not a toggle back and forth. Highlighting
    // (issue #600) is a second, independent async upgrade of that same
    // element once the dynamically-imported grammar resolves, not a third
    // layout state.
    const full = opening + 'g(x);\n```\n\nDone.';
    await rerender({ item: { ...item, text: full }, turnActive: false });
    expect(queryByTestId('md-open-fence')).toBeNull();
    expect(getByTestId('message-text').textContent).not.toContain('```');
    expect(getByTestId('message-text').querySelector('.hljs-keyword')).toBeNull();
    vi.useRealTimers();
    await vi.waitFor(() => {
      expect(getByTestId('message-text').querySelector('.hljs-keyword')).toBeTruthy();
    });
  });

  it('sanitises a <script> and an <img onerror=...> in agent text — neither becomes a live element, and nothing executes', () => {
    const { container } = render(MessageItem, {
      props: {
        item: messageItem({
          text: 'before <script>alert(1)</script> and <img src=x onerror=alert(1)> after',
        }),
      },
    });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
  });

  it('renders thought bodies through the same Markdown pipeline as messages', () => {
    render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk', text: '- one\n- two' }) },
    });
    // Expanded by default (B2-1) — no click needed to reach the body.
    const body = screen.getByTestId('thought-body');
    expect(body.querySelectorAll('li').length).toBe(2);
  });
});
