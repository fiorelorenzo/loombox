/**
 * The cross-cutting keyboard-shortcut primitives (SPEC.md §7.3 "Keyboard &
 * command palette are a cross-cutting requirement"; issue #132). Kept as
 * plain, dependency-free functions over a `KeyboardEvent`-shaped input so
 * they're trivial to unit test without mounting anything, and so
 * `+page.svelte`'s own `svelte:window` listener can stay a thin dispatcher
 * over them.
 */

/**
 * The subset of `KeyboardEvent` {@link matchesShortcut} needs — a plain
 * object satisfies it in a test, no need to construct a real
 * `KeyboardEvent`. `shiftKey`/`altKey`/`code` are optional so an older test
 * (or a caller that only ever matches an unmodified `Mod+<key>` chord)
 * doesn't have to fabricate fields it never reads; each is treated as
 * `false`/`''` when absent, same as a bare keydown with that modifier not
 * held.
 */
export interface KeyboardEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** The physical key ("KeyB", "ArrowRight") — only consulted for a chord that also holds Alt, see {@link matchesShortcut}'s own doc comment for why. */
  code?: string;
}

/** `Right`/`Left`/`Up`/`Down` (this app's shortcut-string spelling, matching Zed/VS Code's own docs) to the real `KeyboardEvent.key` value. Every other key name below is already its own `key` value (a bare letter, digit, or one of `.`/`,`). */
const ARROW_KEY_TO_EVENT_KEY: Record<string, string> = {
  Right: 'ArrowRight',
  Left: 'ArrowLeft',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
};

/** Punctuation key names this app's shortcut strings use, to their `KeyboardEvent.code` value — the rest of {@link expectedEventCode} derives a letter's/digit's/arrow's code programmatically. */
const PUNCTUATION_KEY_TO_CODE: Record<string, string> = {
  '.': 'Period',
  ',': 'Comma',
  '[': 'BracketLeft',
  ']': 'BracketRight',
};

/** The `KeyboardEvent.code` a chord's trailing key segment should compare against once Alt is held — see {@link matchesShortcut}'s own doc comment for why an Alt chord needs `code` instead of `key` at all. `undefined` for a key name this app has never bound behind Alt (nothing today needs it; a future addition should extend this table rather than falling through to a silent non-match). */
function expectedEventCode(keyName: string): string | undefined {
  if (keyName in ARROW_KEY_TO_EVENT_KEY) return ARROW_KEY_TO_EVENT_KEY[keyName];
  if (/^[A-Za-z]$/.test(keyName)) return `Key${keyName.toUpperCase()}`;
  if (/^[0-9]$/.test(keyName)) return `Digit${keyName}`;
  return PUNCTUATION_KEY_TO_CODE[keyName];
}

/**
 * True when `event` matches `shortcut`, a chord in this app's own
 * `Mod+[Shift+][Alt+]<Key>` convention (`Mod+K`, `Mod+.`, and, since #759,
 * `Mod+Shift+P` / `Mod+Alt+B` / `Mod+Alt+Right`) — "Mod" is Cmd on macOS,
 * Ctrl elsewhere, same as the app's existing chords, and every modifier
 * segment is exact: a chord with no `Shift` segment does not match while
 * Shift is held, so `Mod+P` (jump to session) and `Mod+Shift+P` (command
 * palette) can share a letter without one swallowing the other — the old
 * `matchShortcut` in `action-registry.ts` used to strip every modifier but
 * the last `+` segment before calling this module's now-removed
 * `isModShortcut`, so it could never have told those two apart.
 *
 * An `Alt`-bearing chord compares `event.code` (the physical key) instead
 * of `event.key`: macOS remaps `Option+<letter>` to a different character
 * in `key` (`Option+B` reports as `"∫"`, not `"b"`), which would silently
 * break every `Mod+Alt+…` row on a Mac if matched by `key` the way the
 * Alt-free rows still are — `event.code` names the physical key regardless
 * of what Option remaps it to.
 */
export function matchesShortcut(event: KeyboardEventLike, shortcut: string): boolean {
  const segments = shortcut.split('+');
  const keyName = segments.pop();
  if (keyName === undefined || keyName === '') return false;
  const wantMod = segments.includes('Mod');
  const wantShift = segments.includes('Shift');
  const wantAlt = segments.includes('Alt');
  if (wantMod !== Boolean(event.metaKey || event.ctrlKey)) return false;
  if (wantShift !== Boolean(event.shiftKey)) return false;
  if (wantAlt !== Boolean(event.altKey)) return false;
  if (wantAlt) {
    const code = expectedEventCode(keyName);
    return code !== undefined && event.code === code;
  }
  return event.key.toLowerCase() === (ARROW_KEY_TO_EVENT_KEY[keyName] ?? keyName).toLowerCase();
}

/** True when focus is on an element the user is actively typing into — a global shortcut should not fire mid-sentence in the composer or the palette's own search box. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(target.isContentEditable);
}

/**
 * True only inside the desktop app's Electron `BrowserWindow`, never in a
 * plain browser tab (issue #759's F2-3: the desktop shell is where Electron
 * can claim a chord — `Mod+Alt+Right`/`Mod+Alt+Left` for next/previous
 * session, `Mod+N` for new session — that a real browser reserves for its
 * own tab history / new-window chrome and never lets page JS's
 * `preventDefault()` reach). `window.loombox` is the desktop preload's own
 * "am I inside the shell" bridge (`apps/desktop/src/shared/bridge.ts`'s
 * doc comment), duck-typed the same way `AddTargetWizard.svelte`'s
 * `getDesktopBridge` already checks it, so this file doesn't need to import
 * that app's types. Checked fresh on every call rather than cached in a
 * module-level constant: this module is imported by `+page.svelte`, which
 * SvelteKit also renders server-side, where `window` doesn't exist at all —
 * a constant computed once at import time would freeze at whatever the
 * *first* import saw (`false`, server-side) for the lifetime of the Node
 * process, silently wrong for every real browser request after it.
 */
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && 'loombox' in window;
}

/**
 * True when the browser reports a macOS platform — issue #759's other half
 * of the same "can this chord be claimed" question: `Mod+Alt+Right`/`Left`
 * only collides with the browser's own tab-history navigation on Windows
 * and Linux (decision doc §6, F2-3), so a Mac browser tab is exactly as
 * safe as the desktop shell, no `window.loombox` needed. Prefers
 * `navigator.userAgentData.platform` (Chromium; not yet in the standard
 * `Navigator` type, hence the cast) and falls back to the older
 * `navigator.platform` (still populated everywhere else, including
 * Safari/Firefox, despite being deprecated). SSR-safe the same way
 * {@link isDesktopShell} is: `navigator` doesn't exist in Node, so this
 * reads `false` there rather than throwing.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaDataPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  return (uaDataPlatform ?? navigator.platform ?? '').toLowerCase().includes('mac');
}
