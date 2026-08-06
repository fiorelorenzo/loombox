import { describe, expect, it } from 'vitest';
import type { ActionDefinition } from './action-registry';
import { isChordUnavailableHere, isWellFormedChord, validateKeymapCandidate } from './keymap';

function fakeAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    id: 'fake-action',
    label: 'Fake action',
    isAvailable: () => true,
    run: () => {},
    ...overrides,
  };
}

describe('isWellFormedChord', () => {
  it('accepts a bare Mod chord', () => {
    expect(isWellFormedChord('Mod+K')).toBe(true);
  });

  it('accepts Mod+Shift', () => {
    expect(isWellFormedChord('Mod+Shift+P')).toBe(true);
  });

  it('accepts Mod+Alt', () => {
    expect(isWellFormedChord('Mod+Alt+B')).toBe(true);
  });

  it('accepts Mod+Alt with an arrow key', () => {
    expect(isWellFormedChord('Mod+Alt+Right')).toBe(true);
  });

  it('accepts the punctuation key names keyboard.ts knows', () => {
    expect(isWellFormedChord('Mod+.')).toBe(true);
    expect(isWellFormedChord('Mod+,')).toBe(true);
    expect(isWellFormedChord('Mod+[')).toBe(true);
    expect(isWellFormedChord('Mod+]')).toBe(true);
  });

  it('accepts a digit', () => {
    expect(isWellFormedChord('Mod+1')).toBe(true);
  });

  it('rejects a chord with no Mod prefix — this app never binds a bare key at the registry level', () => {
    expect(isWellFormedChord('K')).toBe(false);
  });

  it('rejects Ctrl-spelled chords — this app always spells the platform modifier Mod', () => {
    expect(isWellFormedChord('Ctrl+K')).toBe(false);
  });

  it('rejects out-of-order modifiers', () => {
    expect(isWellFormedChord('Mod+Alt+Shift+B')).toBe(false);
  });

  it('rejects a key name this app has no code mapping for', () => {
    expect(isWellFormedChord('Mod+Enter')).toBe(false);
    expect(isWellFormedChord('Mod+Space')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isWellFormedChord('')).toBe(false);
  });

  it('rejects a multi-character key name', () => {
    expect(isWellFormedChord('Mod+Kb')).toBe(false);
  });
});

describe('validateKeymapCandidate', () => {
  const registry: ActionDefinition[] = [
    fakeAction({ id: 'stop-turn', shortcut: 'Mod+.' }),
    fakeAction({ id: 'toggle-sessions-sidebar', shortcut: 'Mod+B' }),
    fakeAction({ id: 'open-inbox' }),
    fakeAction({
      id: 'next-session',
      shortcutFor: (context) =>
        context.desktopShell || context.macPlatform ? 'Mod+Alt+Right' : undefined,
    }),
  ];

  it('accepts an empty keymap — nothing remapped', () => {
    expect(validateKeymapCandidate({}, registry)).toEqual({ ok: true });
  });

  it('accepts a valid remap of a known action to a free chord', () => {
    expect(validateKeymapCandidate({ 'stop-turn': 'Mod+Shift+X' }, registry)).toEqual({ ok: true });
  });

  it('accepts remapping an action that only ever had shortcutFor, never a plain shortcut', () => {
    expect(validateKeymapCandidate({ 'open-inbox': 'Mod+I' }, registry)).toEqual({ ok: true });
  });

  it('accepts remapping onto a chord an unremapped action used to hold, as long as that action is remapped too', () => {
    // stop-turn moves off Mod+., toggle-sessions-sidebar moves onto it —
    // never simultaneously bound.
    expect(
      validateKeymapCandidate(
        { 'stop-turn': 'Mod+Shift+X', 'toggle-sessions-sidebar': 'Mod+.' },
        registry,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects an unknown action id, naming it', () => {
    expect(validateKeymapCandidate({ 'not-a-real-action': 'Mod+K' }, registry)).toEqual({
      ok: false,
      error: 'Unknown action "not-a-real-action" in keymap',
    });
  });

  it('rejects a malformed chord, naming the entry', () => {
    expect(validateKeymapCandidate({ 'stop-turn': 'ctrl+z' }, registry)).toEqual({
      ok: false,
      error: 'Invalid shortcut "ctrl+z" for "stop-turn"',
    });
  });

  it('rejects remapping two different actions onto the same chord, naming both', () => {
    const result = validateKeymapCandidate(
      { 'stop-turn': 'Mod+B', 'open-inbox': 'Mod+I' },
      registry,
    );
    expect(result).toEqual({
      ok: false,
      error: '"stop-turn" and "toggle-sessions-sidebar" are both bound to Mod+B',
    });
  });

  it('rejects a remap that collides with an action\u2019s environment-conditional default (shortcutFor)', () => {
    const result = validateKeymapCandidate({ 'stop-turn': 'Mod+Alt+Right' }, registry);
    expect(result).toEqual({
      ok: false,
      error: '"stop-turn" and "next-session" are both bound to Mod+Alt+Right',
    });
  });

  it('the previous, still-valid keymap is untouched by a rejected candidate — validation never mutates', () => {
    const previous = { 'stop-turn': 'Mod+Shift+X' };
    const candidate = { ...previous, 'open-inbox': 'not-a-chord' };
    const result = validateKeymapCandidate(candidate, registry);
    expect(result.ok).toBe(false);
    expect(previous).toEqual({ 'stop-turn': 'Mod+Shift+X' });
  });
});

describe('isChordUnavailableHere', () => {
  it('nothing is unavailable inside the desktop shell', () => {
    expect(isChordUnavailableHere('Mod+N', { desktopShell: true, macPlatform: false })).toBe(false);
    expect(
      isChordUnavailableHere('Mod+Alt+Right', { desktopShell: true, macPlatform: false }),
    ).toBe(false);
  });

  it('Mod+N is unavailable in any browser tab, Mac or not', () => {
    expect(isChordUnavailableHere('Mod+N', { desktopShell: false, macPlatform: true })).toBe(true);
    expect(isChordUnavailableHere('Mod+N', { desktopShell: false, macPlatform: false })).toBe(true);
  });

  it('Mod+Alt+Right is unavailable on a Windows/Linux browser tab only, not a Mac one', () => {
    expect(
      isChordUnavailableHere('Mod+Alt+Right', { desktopShell: false, macPlatform: false }),
    ).toBe(true);
    expect(
      isChordUnavailableHere('Mod+Alt+Right', { desktopShell: false, macPlatform: true }),
    ).toBe(false);
  });

  it('an ordinary chord is available everywhere', () => {
    expect(isChordUnavailableHere('Mod+Shift+X', { desktopShell: false, macPlatform: false })).toBe(
      false,
    );
  });
});
