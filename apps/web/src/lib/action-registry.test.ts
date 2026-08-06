import { describe, expect, it, vi } from 'vitest';
import {
  actionRegistry,
  getAvailableActions,
  matchShortcut,
  type ActionContext,
  type ActionHandlers,
} from './action-registry';

const AT_REST: ActionContext = { turnActive: false, sessionCount: 1 };
const MID_TURN: ActionContext = { turnActive: true, sessionCount: 1 };
const MANY_SESSIONS: ActionContext = { turnActive: false, sessionCount: 3 };

function makeHandlers(): ActionHandlers {
  return {
    stopTurn: vi.fn(),
    toggleSessionsSidebar: vi.fn(),
    openInbox: vi.fn(),
    openNodes: vi.fn(),
    selectNextSession: vi.fn(),
    selectPreviousSession: vi.fn(),
  };
}

// ---------------------------------------------------------------------
// Registry shape (issue #758's own "adding a capability without
// registering it is caught" requirement): these assert the invariant a
// bad entry would violate, not any one entry's content.
// ---------------------------------------------------------------------

describe('actionRegistry: shape (issue #758)', () => {
  it('has no duplicate ids', () => {
    const ids = actionRegistry.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate shortcuts among bound actions', () => {
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
});

// ---------------------------------------------------------------------
// Per-action availability (acceptance: "'Stop current turn' appears only
// during a turn, session navigation only with more than one session").
// ---------------------------------------------------------------------

describe('getAvailableActions: predicates (issue #758)', () => {
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
    }
  });

  it('never returns more actions than exist in the registry (nothing conjured outside it)', () => {
    for (const context of [AT_REST, MID_TURN, MANY_SESSIONS]) {
      expect(getAvailableActions(context).length).toBeLessThanOrEqual(actionRegistry.length);
    }
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
// what makes a hand-added `if (isModShortcut(...))` elsewhere pointless,
// since `handleGlobalKeydown` only ever calls this.
// ---------------------------------------------------------------------

describe('matchShortcut (issue #758)', () => {
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
});
