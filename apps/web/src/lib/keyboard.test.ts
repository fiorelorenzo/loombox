// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isDesktopShell, isMacPlatform, isTypingTarget, matchesShortcut } from './keyboard';

describe('matchesShortcut (#132, extended by #759)', () => {
  it('matches Ctrl+key', () => {
    expect(matchesShortcut({ key: 'k', metaKey: false, ctrlKey: true }, 'Mod+K')).toBe(true);
  });

  it('matches Cmd (metaKey)+key', () => {
    expect(matchesShortcut({ key: 'K', metaKey: true, ctrlKey: false }, 'Mod+K')).toBe(true);
  });

  it('does not match without Mod held', () => {
    expect(matchesShortcut({ key: 'k', metaKey: false, ctrlKey: false }, 'Mod+K')).toBe(false);
  });

  it('does not match a different key', () => {
    expect(matchesShortcut({ key: 'j', metaKey: true, ctrlKey: false }, 'Mod+K')).toBe(false);
  });

  it('matches a bare punctuation key (Mod+.)', () => {
    expect(matchesShortcut({ key: '.', metaKey: true, ctrlKey: false }, 'Mod+.')).toBe(true);
  });

  // #759: `Mod+P` (jump to session) and `Mod+Shift+P` (command palette)
  // share a letter — the old `.split('+').pop()` parser this replaces
  // would have matched both on a plain Mod+P press, since it never looked
  // past the last `+` segment.
  it('does not match a plain Mod+key chord when Shift is also held', () => {
    expect(
      matchesShortcut({ key: 'p', metaKey: true, ctrlKey: false, shiftKey: true }, 'Mod+P'),
    ).toBe(false);
  });

  it('matches Mod+Shift+key only with Shift held', () => {
    const base = { key: 'p', metaKey: true, ctrlKey: false };
    expect(matchesShortcut({ ...base, shiftKey: true }, 'Mod+Shift+P')).toBe(true);
    expect(matchesShortcut({ ...base, shiftKey: false }, 'Mod+Shift+P')).toBe(false);
  });

  it('matches Mod+Alt+<letter> via event.code, not event.key', () => {
    // macOS remaps Option+B to "∫" in `key`; `code` still names the
    // physical key regardless of what Option remaps it to.
    expect(
      matchesShortcut(
        {
          key: '∫',
          code: 'KeyB',
          metaKey: true,
          ctrlKey: false,
          altKey: true,
        },
        'Mod+Alt+B',
      ),
    ).toBe(true);
  });

  it('does not match Mod+Alt+<letter> when Alt is not held', () => {
    expect(
      matchesShortcut(
        { key: 'b', code: 'KeyB', metaKey: true, ctrlKey: false, altKey: false },
        'Mod+Alt+B',
      ),
    ).toBe(false);
  });

  it('matches Mod+Alt+Right/Left against ArrowRight/ArrowLeft codes', () => {
    expect(
      matchesShortcut(
        { key: 'ArrowRight', code: 'ArrowRight', metaKey: true, ctrlKey: false, altKey: true },
        'Mod+Alt+Right',
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, ctrlKey: false, altKey: true },
        'Mod+Alt+Left',
      ),
    ).toBe(true);
  });
});

describe('isTypingTarget', () => {
  it('is true for an input element', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
  });

  it('is true for a textarea element', () => {
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
  });

  it('is false for a plain button', () => {
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
  });

  it('is false for null', () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('isDesktopShell (#759)', () => {
  afterEach(() => {
    delete (window as unknown as { loombox?: unknown }).loombox;
  });

  it('is false in a plain browser tab', () => {
    expect(isDesktopShell()).toBe(false);
  });

  it('is true once the desktop preload has exposed window.loombox', () => {
    (window as unknown as { loombox?: unknown }).loombox = {};
    expect(isDesktopShell()).toBe(true);
  });
});

describe('isMacPlatform (#759)', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'platform', {
      value: '',
      configurable: true,
    });
  });

  it('is true when navigator.platform reports MacIntel', () => {
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    expect(isMacPlatform()).toBe(true);
  });

  it('is false when navigator.platform reports a non-Mac platform', () => {
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });
    expect(isMacPlatform()).toBe(false);
  });
});
