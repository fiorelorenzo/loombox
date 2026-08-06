// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptMessageItem } from '@loombox/providers-core/browser';
import { DEFAULT_THOUGHT_DISPLAY_MODE, expandThoughtsStore } from '$lib/expand-thoughts';
import MessageItem from './MessageItem.svelte';

afterEach(() => {
  cleanup();
  // B2-1 (issue #709) made `expanded` a module-level singleton shared by
  // every `MessageItem` instance — reset it after every test so one test's
  // toggle click can't bleed into the next test's "default" assumption
  // (same pattern as `theme.test.ts`/`accent.test.ts` for their own
  // module-level stores).
  expandThoughtsStore.setMode(DEFAULT_THOUGHT_DISPLAY_MODE);
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

  it('starts collapsed by default for a settled thought under the automatic default, and expands on tap (C4-2, issue #745)', async () => {
    render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }) },
    });
    // A thought is still the agent speaking (the accessible label doesn't
    // gain a third value) — "Thought for" already carries the aside itself.
    expect(screen.getByText('Agent')).toBeTruthy();
    // No `thinking` passed (settled/replayed) and the default mode is
    // 'automatic': collapsed the moment real content starts, which for an
    // item that never streamed in this component's lifetime is immediate.
    expect(screen.queryByText('secret reasoning')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Expand thought' }));
    expect(screen.getByText('secret reasoning')).toBeTruthy();
  });

  it('has a working copy affordance', () => {
    render(MessageItem, { props: { item: messageItem() } });
    expect(screen.getByRole('button', { name: 'Copy agent message' })).toBeTruthy();
  });

  it('renders no fork button when onFork is omitted (issue #746)', () => {
    render(MessageItem, { props: { item: messageItem() } });
    expect(screen.queryByRole('button', { name: 'Fork session from here' })).toBeNull();
  });

  it("calls onFork with the item's own turnId when the fork button is clicked (issue #746)", async () => {
    const onFork = vi.fn();
    render(MessageItem, { props: { item: messageItem({ turnId: 'turn-42' }), onFork } });

    await fireEvent.click(screen.getByRole('button', { name: 'Fork session from here' }));

    expect(onFork).toHaveBeenCalledWith('turn-42');
  });

  it('disables the fork button and swaps its label while forking is true (issue #746)', () => {
    render(MessageItem, { props: { item: messageItem(), onFork: vi.fn(), forking: true } });

    const button = screen.getByRole('button', {
      name: 'Forking session…',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("draws the thought disclosure chevron via the shared Icon component (#468), decorative behind the button's own aria-label", () => {
    render(MessageItem, {
      props: {
        item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }),
        thinking: true,
      },
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

  it('thought content follows an explicitly-collapsed mode post-turn and expands on tap (C4-2, issue #745)', async () => {
    expandThoughtsStore.setMode('collapsed');
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

describe('MessageItem: streamed text renders as it arrives, no pacer (issue #757)', () => {
  it('renders replayed/settled history (turnActive omitted) in full immediately, never "typed out"', () => {
    render(MessageItem, { props: { item: messageItem({ text: 'a full historical message' }) } });
    expect(screen.getByTestId('message-text').textContent).toBe('a full historical message');
  });

  it('renders a live burst in full the instant it arrives, with no timer anywhere in this test to catch it up', async () => {
    const { getByTestId, rerender } = render(MessageItem, {
      props: { item: messageItem({ text: '' }), turnActive: true },
    });

    const longBurst = 'x'.repeat(400);
    // No `vi.useFakeTimers`/`advanceTimersByTime` call anywhere in this
    // test: if a pacer (or any other timer) still sat between the chunk
    // and the DOM, this assertion would see a partial string here, not
    // the full burst, on the very next microtask.
    await rerender({ item: messageItem({ text: longBurst }), turnActive: true });
    expect(getByTestId('message-text').textContent).toBe(longBurst);
  });

  it('turn_ended still settles the turn correctly with the flush path gone: text that grew while the turn was live is already the full final text the instant turnActive flips false', async () => {
    const { getByTestId, rerender } = render(MessageItem, {
      props: { item: messageItem({ text: '' }), turnActive: true },
    });

    const longText = 'y'.repeat(300);
    // Growth via a synchronous prop update, the same way the reducer
    // appends chunks onto a live item — proves the text is never left
    // partially revealed while the turn is still active, which is what
    // used to require `TextPacer.flush()` on `turn_ended`.
    await rerender({ item: messageItem({ text: longText }), turnActive: true });
    expect(getByTestId('message-text').textContent).toBe(longText);

    // The turn settles (`turn_ended`): the only turn_ended-specific
    // behavior the old code had here — `pacer.flush()` — is gone
    // entirely. Text was already full before this rerender and stays
    // full after it, proving turn_ended still settles the turn with no
    // flush step required. A regression that reintroduced any lag
    // between chunk arrival and render would already have failed the
    // assertion above, before turnActive even goes false.
    await rerender({ item: messageItem({ text: longText }), turnActive: false });
    expect(getByTestId('message-text').textContent).toBe(longText);
  });

  it('a mid-stream rerender does not remount the item — the DOM node stays the same instance as the item grows', async () => {
    const item = messageItem({ text: '' });
    const { getByTestId, rerender } = render(MessageItem, { props: { item, turnActive: true } });
    const before = getByTestId('message-item');

    await rerender({ item: { ...item, text: 'growing text' }, turnActive: true });
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
  it('B2-1: the disclosure toggle carries no visible text — the label moved above the thought, the accessible name lives in aria-label alone', () => {
    render(MessageItem, {
      props: {
        item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }),
        thinking: true,
      },
    });
    const button = screen.getByRole('button', { name: 'Collapse thought' });
    expect(button.textContent?.trim()).toBe('');
  });

  it('C4-2: the mode is one global preference — changing it applies to every currently-mounted thought, not just one (issue #745)', async () => {
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

    // Both settled, automatic default: both start collapsed.
    expect(screen.queryByText('first thought')).toBeNull();
    expect(screen.queryByText('second thought')).toBeNull();

    // Setting the mode from the store — not clicking a thought's own
    // toggle — is what "one global preference" means now; it reaches
    // every mounted thought at once.
    expandThoughtsStore.setMode('expanded');
    await tick();
    expect(screen.getByText('first thought')).toBeTruthy();
    expect(screen.getByText('second thought')).toBeTruthy();
  });

  it('C4-2 x #661: a manual click is scoped to the thought it was clicked on — it does not bleed into a different, independently-mounted thought', async () => {
    render(MessageItem, {
      props: { item: messageItem({ id: 'a', kind: 'agent_thought_chunk', text: 'first thought' }) },
    });
    render(MessageItem, {
      props: {
        item: messageItem({ id: 'b', kind: 'agent_thought_chunk', text: 'second thought' }),
      },
    });

    // Both collapsed under the automatic default; expanding the first by
    // hand must not also reveal the second — proof the override is a
    // per-component escape hatch, not a rename of the old shared boolean.
    const [firstToggle] = screen.getAllByRole('button', { name: 'Expand thought' });
    await fireEvent.click(firstToggle);
    expect(screen.getByText('first thought')).toBeTruthy();
    expect(screen.queryByText('second thought')).toBeNull();
  });

  it('C4-2 x #660: under automatic (the default), a thought producing text stays visible and keeps growing, then collapses back once real content settles', async () => {
    const item = messageItem({ kind: 'agent_thought_chunk', text: '' });
    const { getByTestId, queryByTestId, rerender } = render(MessageItem, {
      props: { item, thinking: true, turnActive: true },
    });

    // Automatic, actively thinking: the body must already be in the DOM
    // with no click — this is the exact collapsed-container collision
    // #660 names (a thought streaming into a collapsed container is why
    // #660's own fake stayed green for months).
    expect(queryByTestId('thought-body')).toBeTruthy();

    const full = 'reasoning about the empty-table edge case in some detail';
    const partial = full.slice(0, 20);
    // A real chunk arrival, not a timer tick: the body shows exactly what
    // has arrived so far, immediately (issue #757 — no pacing).
    await rerender({ item: { ...item, text: partial }, thinking: true, turnActive: true });
    expect(getByTestId('thought-body').textContent).toBe(partial);

    await rerender({ item: { ...item, text: full }, thinking: true, turnActive: true });
    expect(getByTestId('thought-body').textContent).toBe(full);

    // Once thinking ends, automatic collapses right back — "collapses to
    // one line the moment real content starts" is C4-2's own wording.
    await rerender({ item: { ...item, text: full }, thinking: false, turnActive: false });
    expect(queryByTestId('thought-body')).toBeNull();
  });

  it("C4-2: 'collapsed' is stricter than automatic — it never shows the body, even while the thought is actively producing text", () => {
    expandThoughtsStore.setMode('collapsed');
    render(MessageItem, {
      props: {
        item: messageItem({ kind: 'agent_thought_chunk', text: 'reasoning so far' }),
        thinking: true,
        turnActive: true,
      },
    });
    expect(screen.queryByTestId('thought-body')).toBeNull();
    // 'collapsed' only ever suppresses the thought's own text — the header
    // still shows real-time activity through the timer and woven-thread
    // motif, same as every other mode.
    expect(screen.getByTestId('thinking-timer')).toBeTruthy();
    expect(screen.getByTestId('woven-loader')).toBeTruthy();
  });

  it("C4-2: 'expanded' always shows the body, streaming or settled", () => {
    expandThoughtsStore.setMode('expanded');
    render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk', text: 'settled reasoning' }) },
    });
    expect(screen.getByTestId('thought-body').textContent).toBe('settled reasoning');
  });
});

describe('MessageItem: Markdown rendering (issue #574)', () => {
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

  it('renders a still-open fence as a plain, unhighlighted monospace box at several intermediate arrival points, then highlights it once closed with no flicker between two layouts', async () => {
    const opening = 'Explain:\n\n```ts\nconst x: number = 1;\nconsole.lo';
    const item = messageItem({ text: '' });
    const { getByTestId, queryByTestId, rerender } = render(MessageItem, {
      props: { item, turnActive: true },
    });

    // Several intermediate arrival points while the fence is still open —
    // real chunk growth, not a timer of any kind: it always renders as
    // the plain monospace box, never with token spans, and never
    // disappears.
    for (const cut of [10, 25, opening.length]) {
      await rerender({ item: { ...item, text: opening.slice(0, cut) }, turnActive: true });
      const openFence = queryByTestId('md-open-fence');
      if (openFence) {
        expect(openFence.querySelector('.hljs-keyword')).toBeNull();
        expect(openFence.tagName).toBe('PRE');
      }
    }
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
      props: {
        item: messageItem({ kind: 'agent_thought_chunk', text: '- one\n- two' }),
        thinking: true,
      },
    });
    // thinking: true keeps it visible under the automatic default (C4-2,
    // issue #745) — this test is about the Markdown pipeline, not the
    // display mode itself.
    const body = screen.getByTestId('thought-body');
    expect(body.querySelectorAll('li').length).toBe(2);
  });
});
