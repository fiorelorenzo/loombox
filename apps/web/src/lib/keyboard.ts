/**
 * The cross-cutting keyboard-shortcut primitives (SPEC.md §7.3 "Keyboard &
 * command palette are a cross-cutting requirement"; issue #132). Kept as
 * plain, dependency-free functions over a `KeyboardEvent`-shaped input so
 * they're trivial to unit test without mounting anything, and so
 * `+page.svelte`'s own `svelte:window` listener can stay a thin dispatcher
 * over them.
 */

/** The subset of `KeyboardEvent` these helpers need — a plain object satisfies it in a test, no need to construct a real `KeyboardEvent`. */
export interface KeyboardEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}

/**
 * True when `event` is the platform's "Mod" chord (Cmd on macOS, Ctrl
 * elsewhere) plus `key` — the convention every shortcut in this app's
 * palette hints use (`Mod+K`, `Mod+.`), so a Mac user's Cmd and everyone
 * else's Ctrl both work without this app needing to sniff the platform.
 */
export function isModShortcut(event: KeyboardEventLike, key: string): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === key.toLowerCase();
}

/** True when focus is on an element the user is actively typing into — a global shortcut should not fire mid-sentence in the composer or the palette's own search box. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(target.isContentEditable);
}
