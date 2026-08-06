// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CanvasZeroState, {
  type CanvasZeroStateRecentSession,
  type CanvasZeroStateTranscriptPreview,
} from './CanvasZeroState.svelte';
import { actionRegistry } from '$lib/action-registry';

afterEach(() => cleanup());

const SESSION: CanvasZeroStateRecentSession = {
  id: 'sess_1',
  title: 'Refactor relay routing',
  projectLabel: 'loombox',
  targetLabel: "Ada's MacBook",
  activityLabel: '5m ago',
};

const TAIL: CanvasZeroStateTranscriptPreview = {
  sessionId: 'sess_1',
  sessionTitle: 'Refactor relay routing',
  items: [
    { id: 'm1', speaker: 'user', text: 'Fix the flaky retry loop' },
    { id: 'm2', speaker: 'agent', text: 'Found it — the backoff never resets.' },
  ],
};

describe('CanvasZeroState (Zed-parity B4-2, issue #739)', () => {
  // -----------------------------------------------------------------
  // The two honest empty cases (acceptance: "render something honest
  // rather than a blank region or a fabricated example").
  // -----------------------------------------------------------------

  it('a brand-new project with nothing recent renders an honest "nothing yet" line, not a blank region', () => {
    render(CanvasZeroState, {
      props: { recentSessions: [], lastTranscript: undefined, onSelectSession: vi.fn() },
    });

    expect(screen.getByTestId('canvas-zero-state-recent-empty').textContent).toMatch(
      /nothing recent yet/i,
    );
    expect(screen.queryByTestId('canvas-zero-state-recent-item')).toBeNull();
    // No session anywhere to have a tail at all — the OTHER honest empty
    // case, worded distinctly from "this session has zero turns".
    expect(screen.getByTestId('canvas-zero-state-tail-empty').textContent).toMatch(
      /no sessions yet/i,
    );
  });

  it('a session that genuinely has zero turns renders its own honest line, never a fabricated transcript line', () => {
    render(CanvasZeroState, {
      props: {
        recentSessions: [SESSION],
        lastTranscript: { sessionId: 'sess_1', sessionTitle: 'Fresh session', items: [] },
        onSelectSession: vi.fn(),
      },
    });

    expect(screen.getByTestId('canvas-zero-state-tail-empty').textContent).toMatch(
      /fresh session.*no turns yet/i,
    );
    expect(screen.queryByTestId('canvas-zero-state-tail-item')).toBeNull();
    // Distinct wording from "no sessions yet at all" — this session is
    // real, it simply has nothing said in it yet.
    expect(screen.getByTestId('canvas-zero-state-tail-empty').textContent).not.toMatch(
      /no sessions yet/i,
    );
  });

  it('renders real recent sessions and a real transcript tail when both exist', () => {
    render(CanvasZeroState, {
      props: { recentSessions: [SESSION], lastTranscript: TAIL, onSelectSession: vi.fn() },
    });

    const recentItem = screen.getByTestId('canvas-zero-state-recent-item');
    expect(within(recentItem).getByText('Refactor relay routing')).toBeTruthy();
    expect(recentItem.textContent).toContain('loombox');
    expect(recentItem.textContent).toContain("Ada's MacBook");
    expect(recentItem.textContent).toContain('5m ago');

    const tailItems = screen.getAllByTestId('canvas-zero-state-tail-item');
    expect(tailItems).toHaveLength(2);
    expect(tailItems[0].textContent).toContain('Fix the flaky retry loop');
    expect(tailItems[1].textContent).toContain('Found it');
  });

  it('clicking a recent session calls onSelectSession with its id', async () => {
    const onSelectSession = vi.fn();
    render(CanvasZeroState, {
      props: { recentSessions: [SESSION], lastTranscript: TAIL, onSelectSession },
    });

    await fireEvent.click(screen.getByTestId('canvas-zero-state-recent-item'));
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith('sess_1');
  });

  // -----------------------------------------------------------------
  // Bindings read from the registry (acceptance: "asserted by a test
  // that would fail if they drifted").
  // -----------------------------------------------------------------

  it('renders exactly the action-registry entries that carry a shortcut, with their real label and chord', () => {
    render(CanvasZeroState, {
      props: { recentSessions: [], lastTranscript: undefined, onSelectSession: vi.fn() },
    });

    const expected = actionRegistry.filter((action) => action.shortcut !== undefined);
    // Sanity: today's registry actually declares at least one shortcut, so
    // this test would catch the registry ever losing every binding, not
    // just drifting one.
    expect(expected.length).toBeGreaterThan(0);

    const rows = screen.getAllByTestId('canvas-zero-state-binding');
    expect(rows).toHaveLength(expected.length);
    for (const [index, action] of expected.entries()) {
      expect(rows[index].textContent).toContain(action.shortcut);
      expect(rows[index].textContent).toContain(action.label);
    }
  });

  it("never renders a binding for an action the registry declares with no shortcut (e.g. 'open-inbox')", () => {
    render(CanvasZeroState, {
      props: { recentSessions: [], lastTranscript: undefined, onSelectSession: vi.fn() },
    });

    const shortcutless = actionRegistry.find((action) => action.shortcut === undefined);
    expect(shortcutless).toBeDefined();
    const rows = screen.getAllByTestId('canvas-zero-state-binding');
    expect(rows.every((row) => !row.textContent?.includes(shortcutless!.label))).toBe(true);
  });

  it('renders the caller-supplied CTA slot when provided', () => {
    const cta = createRawSnippet(() => ({
      render: () => '<button type="button">New session</button>',
    }));
    render(CanvasZeroState, {
      props: { recentSessions: [], lastTranscript: undefined, onSelectSession: vi.fn(), cta },
    });
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy();
  });
});
