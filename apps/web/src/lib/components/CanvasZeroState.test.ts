// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CanvasZeroState, {
  type CanvasZeroStateRecentSession,
  type CanvasZeroStateTranscriptPreview,
} from './CanvasZeroState.svelte';
import { actionRegistry, effectiveShortcut, type ActionContext } from '$lib/action-registry';

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
    { id: 't1', speaker: 'user', text: 'Fix the flaky retry loop' },
    { id: 't2', speaker: 'agent', text: 'Found it' },
  ],
};

/**
 * The zero state's own context has no session selected and no more than
 * one session in existence — `sessionSelected`/`hasConfigOptions` are
 * always `false` here in real use, matching the panel's own doc comment
 * ("this panel orients someone with no session open at all"). `projects`
 * is real (this panel only renders once a project exists at all — see
 * `+page.svelte`'s `emptyStateCta`), so `hasProjects` stays `true`.
 */
const BASE_CONTEXT: ActionContext = {
  turnActive: false,
  sessionCount: 0,
  sessionSelected: false,
  hasProjects: true,
  hasConfigOptions: false,
  desktopShell: false,
  macPlatform: false,
};

describe('CanvasZeroState (Zed-parity B4-2, issue #739)', () => {
  // -----------------------------------------------------------------
  // The two honest empty cases (acceptance: "render something honest
  // rather than a blank region or a fabricated example").
  // -----------------------------------------------------------------

  it('a brand-new project with nothing recent renders an honest "nothing yet" line, not a blank region', () => {
    render(CanvasZeroState, {
      props: {
        recentSessions: [],
        lastTranscript: undefined,
        onSelectSession: vi.fn(),
        context: BASE_CONTEXT,
      },
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
        context: BASE_CONTEXT,
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
      props: {
        recentSessions: [SESSION],
        lastTranscript: TAIL,
        onSelectSession: vi.fn(),
        context: BASE_CONTEXT,
      },
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
      props: {
        recentSessions: [SESSION],
        lastTranscript: TAIL,
        onSelectSession,
        context: BASE_CONTEXT,
      },
    });

    await fireEvent.click(screen.getByTestId('canvas-zero-state-recent-item'));
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith('sess_1');
  });

  // -----------------------------------------------------------------
  // Bindings read from the registry (acceptance: "asserted by a test
  // that would fail if they drifted"). Issue #759 extended this to read
  // `effectiveShortcut` (context-resolved), not the plain `shortcut`
  // field, since `next-session`/`previous-session`/`new-session` now
  // resolve their binding per environment.
  // -----------------------------------------------------------------

  it('renders exactly the action-registry entries whose effectiveShortcut resolves in this context, with their real label and chord', () => {
    render(CanvasZeroState, {
      props: {
        recentSessions: [],
        lastTranscript: undefined,
        onSelectSession: vi.fn(),
        context: BASE_CONTEXT,
      },
    });

    const expected = actionRegistry
      .map((action) => ({ action, shortcut: effectiveShortcut(action, BASE_CONTEXT) }))
      .filter(
        (entry): entry is { action: (typeof actionRegistry)[number]; shortcut: string } =>
          entry.shortcut !== undefined,
      );
    // Sanity: today's registry actually declares at least one shortcut, so
    // this test would catch the registry ever losing every binding, not
    // just drifting one.
    expect(expected.length).toBeGreaterThan(0);

    const rows = screen.getAllByTestId('canvas-zero-state-binding');
    expect(rows).toHaveLength(expected.length);
    for (const [index, entry] of expected.entries()) {
      expect(rows[index].textContent).toContain(entry.shortcut);
      expect(rows[index].textContent).toContain(entry.action.label);
    }
  });

  it("never renders a binding for an action whose effectiveShortcut is undefined in this context (e.g. 'open-nodes', which never has one)", () => {
    render(CanvasZeroState, {
      props: {
        recentSessions: [],
        lastTranscript: undefined,
        onSelectSession: vi.fn(),
        context: BASE_CONTEXT,
      },
    });

    const shortcutless = actionRegistry.find(
      (action) => effectiveShortcut(action, BASE_CONTEXT) === undefined,
    );
    expect(shortcutless).toBeDefined();
    const rows = screen.getAllByTestId('canvas-zero-state-binding');
    expect(rows.every((row) => !row.textContent?.includes(shortcutless!.label))).toBe(true);
  });

  // -----------------------------------------------------------------
  // Issue #759's own gap this fixes: `next-session`/`previous-session`/
  // `new-session` carry no plain `shortcut` string at all (only
  // `shortcutFor`), so reading the static field alone (this panel's
  // behaviour before #759) would have hidden all three here in every
  // environment, including the desktop shell and a Mac browser tab where
  // they DO have a real, working chord.
  // -----------------------------------------------------------------

  it('shows "New session" (Mod+N) inside the desktop shell, where the chord is safe to claim', () => {
    render(CanvasZeroState, {
      props: {
        recentSessions: [],
        lastTranscript: undefined,
        onSelectSession: vi.fn(),
        context: { ...BASE_CONTEXT, desktopShell: true },
      },
    });

    const rows = screen.getAllByTestId('canvas-zero-state-binding');
    expect(
      rows.some(
        (row) => row.textContent?.includes('Mod+N') && row.textContent?.includes('New session'),
      ),
    ).toBe(true);
  });

  it('omits "New session"\'s chord on a plain browser tab, where Mod+N is reserved by the browser — the action has no static `shortcut` to fall back on', () => {
    render(CanvasZeroState, {
      props: {
        recentSessions: [],
        lastTranscript: undefined,
        onSelectSession: vi.fn(),
        context: BASE_CONTEXT,
      },
    });

    const rows = screen.getAllByTestId('canvas-zero-state-binding');
    expect(rows.some((row) => row.textContent?.includes('New session'))).toBe(false);
  });

  it('renders the caller-supplied CTA slot when provided', () => {
    const cta = createRawSnippet(() => ({
      render: () => '<button type="button">New session</button>',
    }));
    render(CanvasZeroState, {
      props: {
        recentSessions: [],
        lastTranscript: undefined,
        onSelectSession: vi.fn(),
        context: BASE_CONTEXT,
        cta,
      },
    });
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy();
  });
});
