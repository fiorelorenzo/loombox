import { describe, expect, it, vi } from 'vitest';
import {
  actionRegistry,
  effectiveShortcut,
  getAvailableActions,
  matchShortcut,
  type ActionContext,
  type ActionHandlers,
} from './action-registry';

const BASE: ActionContext = {
  turnActive: false,
  sessionCount: 1,
  sessionSelected: true,
  hasProjects: true,
  hasConfigOptions: true,
  desktopShell: false,
  macPlatform: false,
};

const AT_REST: ActionContext = BASE;
const MID_TURN: ActionContext = { ...BASE, turnActive: true };
const MANY_SESSIONS: ActionContext = { ...BASE, sessionCount: 3 };
/** No session selected at all (the app's initial/empty-state screen) — every session-scoped action (composer, workbench panel, terminal dock, model/effort picker) should disappear. */
const NO_SESSION: ActionContext = {
  ...BASE,
  sessionSelected: false,
  hasConfigOptions: false,
};
/** A brand-new account with no project yet — "New session" has nowhere to aim. */
const NO_PROJECTS: ActionContext = { ...BASE, hasProjects: false };
/** A session whose agent hasn't reported its config catalog yet — `ConfigBar` renders no trigger. */
const NO_CONFIG_OPTIONS: ActionContext = { ...BASE, hasConfigOptions: false };
/** Windows/Linux, the desktop shell (issue #759 F2-3: safe to claim `Mod+Alt+Right`/`Left`/`Mod+N` here regardless of platform). */
const DESKTOP_SHELL: ActionContext = { ...BASE, sessionCount: 3, desktopShell: true };
/** macOS, a plain browser tab (issue #759 F2-3: safe to claim `Mod+Alt+Right`/`Left` here too — the collision is Windows/Linux-only — but not `Mod+N`, reserved on every platform's browser). */
const MAC_WEB: ActionContext = { ...BASE, sessionCount: 3, macPlatform: true };
/** Windows/Linux, a plain browser tab — the one environment where `Mod+Alt+Right`/`Left`/`Mod+N` must NOT be offered. */
const WINDOWS_LINUX_WEB: ActionContext = { ...BASE, sessionCount: 3 };

function makeHandlers(): ActionHandlers {
  return {
    stopTurn: vi.fn(),
    toggleSessionsSidebar: vi.fn(),
    openInbox: vi.fn(),
    openNodes: vi.fn(),
    selectNextSession: vi.fn(),
    selectPreviousSession: vi.fn(),
    createSession: vi.fn(),
    toggleWorkbenchPanel: vi.fn(),
    toggleTerminalDock: vi.fn(),
    focusComposer: vi.fn(),
    openSettings: vi.fn(),
    openConfigPopover: vi.fn(),
  };
}

// ---------------------------------------------------------------------
// Registry shape (issue #758's own "adding a capability without
// registering it is caught" requirement): these assert the invariant a
// bad entry would violate, not any one entry's content.
// ---------------------------------------------------------------------

describe('actionRegistry: shape (issue #758, extended by #759)', () => {
  it('has no duplicate ids', () => {
    const ids = actionRegistry.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate static shortcuts among bound actions', () => {
    const shortcuts = actionRegistry.map((action) => action.shortcut).filter(Boolean);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it('every entry has a non-empty label, a real predicate and a real handler', () => {
    for (const action of actionRegistry) {
      expect(action.id.length).toBeGreaterThan(0);
      expect(action.label.length).toBeGreaterThan(0);
      expect(typeof action.isAvailable).toBe('function');
      expect(typeof action.run).toBe('function');
    }
  });

  // #759's own risk: "New session"/"Next session"/"Previous session" all
  // resolve their effective shortcut per environment (`shortcutFor`) — this
  // asserts no two actions ever land on the same live chord in any real
  // environment, not just among the actions that happen to declare a
  // static `shortcut`.
  it('has no duplicate effective shortcuts in any real environment', () => {
    for (const context of [
      AT_REST,
      MID_TURN,
      MANY_SESSIONS,
      DESKTOP_SHELL,
      MAC_WEB,
      WINDOWS_LINUX_WEB,
    ]) {
      const shortcuts = actionRegistry
        .map((action) => effectiveShortcut(action, context))
        .filter((shortcut): shortcut is string => shortcut !== undefined);
      expect(new Set(shortcuts).size).toBe(shortcuts.length);
    }
  });
});

// ---------------------------------------------------------------------
// Per-action availability (acceptance: "'Stop current turn' appears only
// during a turn, session navigation only with more than one session").
// ---------------------------------------------------------------------

describe('getAvailableActions: predicates (issue #758, extended by #759)', () => {
  it('hides "Stop current turn" at rest and shows it once a turn is active', () => {
    expect(getAvailableActions(AT_REST).map((a) => a.id)).not.toContain('stop-turn');
    expect(getAvailableActions(MID_TURN).map((a) => a.id)).toContain('stop-turn');
  });

  it('hides "Next session"/"Previous session" with only one session, shows them with more than one', () => {
    const solo = getAvailableActions(AT_REST).map((a) => a.id);
    expect(solo).not.toContain('next-session');
    expect(solo).not.toContain('previous-session');

    const many = getAvailableActions(MANY_SESSIONS).map((a) => a.id);
    expect(many).toContain('next-session');
    expect(many).toContain('previous-session');
  });

  it('always includes the unconditional actions regardless of context', () => {
    for (const context of [AT_REST, MID_TURN, MANY_SESSIONS]) {
      const ids = getAvailableActions(context).map((a) => a.id);
      expect(ids).toContain('toggle-sessions-sidebar');
      expect(ids).toContain('open-inbox');
      expect(ids).toContain('open-nodes');
      expect(ids).toContain('open-settings');
    }
  });

  it('never returns more actions than exist in the registry (nothing conjured outside it)', () => {
    for (const context of [AT_REST, MID_TURN, MANY_SESSIONS]) {
      expect(getAvailableActions(context).length).toBeLessThanOrEqual(actionRegistry.length);
    }
  });

  it('hides session-scoped actions (workbench panel, terminal dock, composer, model/effort) with no session selected', () => {
    const ids = getAvailableActions(NO_SESSION).map((a) => a.id);
    expect(ids).not.toContain('toggle-workbench-panel');
    expect(ids).not.toContain('toggle-terminal-dock');
    expect(ids).not.toContain('focus-composer');
    expect(ids).not.toContain('cycle-model-effort');
  });

  it('shows session-scoped actions once a session is selected', () => {
    const ids = getAvailableActions(AT_REST).map((a) => a.id);
    expect(ids).toContain('toggle-workbench-panel');
    expect(ids).toContain('toggle-terminal-dock');
    expect(ids).toContain('focus-composer');
    expect(ids).toContain('cycle-model-effort');
  });

  it('hides "Cycle model / effort" when the session has no config options yet, even with a session selected', () => {
    const ids = getAvailableActions(NO_CONFIG_OPTIONS).map((a) => a.id);
    expect(ids).not.toContain('cycle-model-effort');
    expect(ids).toContain('toggle-workbench-panel');
  });

  it('hides "New session" with no project to create into', () => {
    expect(getAvailableActions(NO_PROJECTS).map((a) => a.id)).not.toContain('new-session');
    expect(getAvailableActions(AT_REST).map((a) => a.id)).toContain('new-session');
  });
});

// ---------------------------------------------------------------------
// run() wiring: each action calls exactly the handler it names.
// ---------------------------------------------------------------------

describe('ActionDefinition.run: dispatches to the right handler', () => {
  it.each([
    ['stop-turn', 'stopTurn'],
    ['toggle-sessions-sidebar', 'toggleSessionsSidebar'],
    ['open-inbox', 'openInbox'],
    ['open-nodes', 'openNodes'],
    ['next-session', 'selectNextSession'],
    ['previous-session', 'selectPreviousSession'],
    ['new-session', 'createSession'],
    ['toggle-workbench-panel', 'toggleWorkbenchPanel'],
    ['toggle-terminal-dock', 'toggleTerminalDock'],
    ['focus-composer', 'focusComposer'],
    ['open-settings', 'openSettings'],
    ['cycle-model-effort', 'openConfigPopover'],
  ] as const)('%s calls handlers.%s', (id, handlerName) => {
    const action = actionRegistry.find((entry) => entry.id === id);
    expect(action).toBeTruthy();
    const handlers = makeHandlers();
    action?.run(handlers);
    expect(handlers[handlerName]).toHaveBeenCalledOnce();
    for (const [name, fn] of Object.entries(handlers)) {
      if (name !== handlerName) expect(fn).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------
// matchShortcut: the global keydown dispatcher's own lookup — this is
// what makes a hand-added `if (matchesShortcut(...))` elsewhere pointless,
// since `handleGlobalKeydown` only ever calls this.
// ---------------------------------------------------------------------

describe('matchShortcut (issue #758, extended by #759)', () => {
  it('resolves Mod+. to stop-turn only while a turn is active', () => {
    expect(matchShortcut({ key: '.', metaKey: true, ctrlKey: false }, MID_TURN)?.id).toBe(
      'stop-turn',
    );
    expect(matchShortcut({ key: '.', metaKey: true, ctrlKey: false }, AT_REST)).toBeUndefined();
  });

  it('resolves Mod+B to toggle-sessions-sidebar regardless of turn/session state', () => {
    expect(matchShortcut({ key: 'b', metaKey: true, ctrlKey: false }, AT_REST)?.id).toBe(
      'toggle-sessions-sidebar',
    );
    expect(matchShortcut({ key: 'B', ctrlKey: true, metaKey: false }, MANY_SESSIONS)?.id).toBe(
      'toggle-sessions-sidebar',
    );
  });

  it('matches without the Mod chord held not at all, and an unbound chord not at all — the drift guard: nothing outside this registry can make a new shortcut fire', () => {
    expect(matchShortcut({ key: 'b', metaKey: false, ctrlKey: false }, AT_REST)).toBeUndefined();
    expect(
      matchShortcut({ key: 'z', metaKey: true, ctrlKey: false }, MANY_SESSIONS),
    ).toBeUndefined();
  });

  it('resolves Mod+Shift+A to open-inbox, but plain Mod+A to nothing', () => {
    expect(
      matchShortcut({ key: 'a', metaKey: true, ctrlKey: false, shiftKey: true }, AT_REST)?.id,
    ).toBe('open-inbox');
    expect(
      matchShortcut({ key: 'a', metaKey: true, ctrlKey: false, shiftKey: false }, AT_REST),
    ).toBeUndefined();
  });

  it('resolves Mod+, to open-settings', () => {
    expect(matchShortcut({ key: ',', metaKey: true, ctrlKey: false }, AT_REST)?.id).toBe(
      'open-settings',
    );
  });

  it('resolves Mod+I to focus-composer only with a session selected', () => {
    expect(matchShortcut({ key: 'i', metaKey: true, ctrlKey: false }, AT_REST)?.id).toBe(
      'focus-composer',
    );
    expect(matchShortcut({ key: 'i', metaKey: true, ctrlKey: false }, NO_SESSION)).toBeUndefined();
  });

  it('resolves Mod+Shift+M to cycle-model-effort only once the session has config options', () => {
    expect(
      matchShortcut({ key: 'm', metaKey: true, ctrlKey: false, shiftKey: true }, AT_REST)?.id,
    ).toBe('cycle-model-effort');
    expect(
      matchShortcut({ key: 'm', metaKey: true, ctrlKey: false, shiftKey: true }, NO_CONFIG_OPTIONS),
    ).toBeUndefined();
  });

  it('resolves Mod+Alt+B to toggle-workbench-panel via event.code (Alt-safe on macOS)', () => {
    expect(
      matchShortcut(
        { key: '∫', code: 'KeyB', metaKey: true, ctrlKey: false, altKey: true },
        AT_REST,
      )?.id,
    ).toBe('toggle-workbench-panel');
  });

  it('resolves Mod+J to toggle-terminal-dock', () => {
    expect(matchShortcut({ key: 'j', metaKey: true, ctrlKey: false }, AT_REST)?.id).toBe(
      'toggle-terminal-dock',
    );
  });

  // #759's own named risk: Mod+Alt+Right/Left must fire in the desktop
  // shell and on a Mac browser tab, and must NOT fire (nothing "silently
  // does nothing" — it simply isn't bound) on a Windows/Linux browser tab.
  describe('Mod+Alt+Right/Left (next/previous session) — platform-conditional per #759 F2-3', () => {
    const rightArrow = {
      key: 'ArrowRight',
      code: 'ArrowRight',
      metaKey: true,
      ctrlKey: false,
      altKey: true,
    };
    const leftArrow = {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      metaKey: true,
      ctrlKey: false,
      altKey: true,
    };

    it('fires inside the desktop shell', () => {
      expect(matchShortcut(rightArrow, DESKTOP_SHELL)?.id).toBe('next-session');
      expect(matchShortcut(leftArrow, DESKTOP_SHELL)?.id).toBe('previous-session');
    });

    it('fires on a Mac browser tab', () => {
      expect(matchShortcut(rightArrow, MAC_WEB)?.id).toBe('next-session');
      expect(matchShortcut(leftArrow, MAC_WEB)?.id).toBe('previous-session');
    });

    it('does not fire on a Windows/Linux browser tab — the action stays reachable via the palette, only the chord is withheld', () => {
      expect(matchShortcut(rightArrow, WINDOWS_LINUX_WEB)).toBeUndefined();
      expect(matchShortcut(leftArrow, WINDOWS_LINUX_WEB)).toBeUndefined();
      expect(getAvailableActions(WINDOWS_LINUX_WEB).map((a) => a.id)).toContain('next-session');
      expect(getAvailableActions(WINDOWS_LINUX_WEB).map((a) => a.id)).toContain('previous-session');
    });

    it('the palette shows no shortcut hint for next/previous session on a Windows/Linux browser tab', () => {
      const nextSession = actionRegistry.find((a) => a.id === 'next-session');
      expect(nextSession).toBeTruthy();
      expect(effectiveShortcut(nextSession!, WINDOWS_LINUX_WEB)).toBeUndefined();
      expect(effectiveShortcut(nextSession!, DESKTOP_SHELL)).toBe('Mod+Alt+Right');
      expect(effectiveShortcut(nextSession!, MAC_WEB)).toBe('Mod+Alt+Right');
    });
  });

  // #759's inherited F2-2 risk: Mod+N is reserved by every browser, on
  // every platform, so it is desktop-shell-only regardless of macOS/
  // Windows/Linux (unlike the Alt-arrow rows, which are safe on a Mac
  // browser tab too).
  describe('Mod+N (new session) — desktop-shell-only per #759', () => {
    const modN = { key: 'n', metaKey: true, ctrlKey: false };

    it('fires inside the desktop shell', () => {
      expect(matchShortcut(modN, DESKTOP_SHELL)?.id).toBe('new-session');
    });

    it('does not fire on a Mac browser tab either — Mod+N is reserved everywhere a browser owns the chrome', () => {
      expect(matchShortcut(modN, MAC_WEB)).toBeUndefined();
    });

    it('does not fire on a Windows/Linux browser tab', () => {
      expect(matchShortcut(modN, WINDOWS_LINUX_WEB)).toBeUndefined();
    });

    it('the action stays reachable via the palette in every environment', () => {
      expect(getAvailableActions(WINDOWS_LINUX_WEB).map((a) => a.id)).toContain('new-session');
      expect(getAvailableActions(MAC_WEB).map((a) => a.id)).toContain('new-session');
      expect(getAvailableActions(DESKTOP_SHELL).map((a) => a.id)).toContain('new-session');
    });
  });
});
