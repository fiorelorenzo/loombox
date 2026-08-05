import { writable, type Readable } from 'svelte/store';

/**
 * The "expand thoughts" preference (design spec
 * `2026-08-05-cockpit-v8-decisions.md` §2, decision B2-1, issue #709).
 * Today `expanded` is per-`MessageItem` local state defaulting to `false`
 * and nothing persists, so a reload — or a new thought in the same
 * transcript — always starts collapsed again. Lorenzo's own ask ("di
 * default espanso e poi ricorda la scelta" — expanded by default, then
 * remember the choice) and the pick he made from the options ("la scelta"
 * is singular) both land on the cheapest shape: one boolean in
 * `localStorage`, read once and applied to every thought in every
 * session — the same shape as `$lib/accent.ts`'s own store (a
 * module-level `writable`, a `readStored*`/`persist` pair, and an
 * `init()` a caller runs once client-side; see that file's doc comment
 * for why the shape looks like this).
 *
 * This module deliberately carries no theme-ground tracking the way
 * `accent.ts` does — a plain boolean has nothing to re-derive when the
 * theme changes, so `init()` here is a one-shot read, not a subscription.
 */
const STORAGE_KEY = 'loombox:expand-thoughts';

/** Lorenzo's own ask: a thought starts open, not collapsed — the inverse of today's hardcoded `$state(false)`. */
export const DEFAULT_EXPAND_THOUGHTS = true;

/** Reads the persisted preference, defaulting to expanded — SSR/non-browser-safe (no `localStorage` during SSR renders). A stored value other than exactly `'true'`/`'false'` (corrupt, or written by a future format) falls back to the default rather than silently reading as collapsed. */
function readStoredExpandThoughts(): boolean {
  if (typeof localStorage === 'undefined') return DEFAULT_EXPAND_THOUGHTS;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return DEFAULT_EXPAND_THOUGHTS;
}

/**
 * The app-wide "expand thoughts" preference store — a single module-level
 * instance, same shape as `accent.ts`'s own store.
 */
function createExpandThoughtsStore(): {
  expanded: Readable<boolean>;
  setExpanded: (value: boolean) => void;
  toggle: () => void;
  /** Applies the currently-stored preference — call once, client-side, on app startup (mirrors `theme.ts`'s/`accent.ts`'s `init()`). */
  init: () => void;
} {
  const store = writable<boolean>(DEFAULT_EXPAND_THOUGHTS);
  let current = DEFAULT_EXPAND_THOUGHTS;

  function persist(value: boolean): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, String(value));
  }

  function setExpanded(value: boolean): void {
    current = value;
    store.set(value);
    persist(value);
  }

  function toggle(): void {
    setExpanded(!current);
  }

  function init(): void {
    const stored = readStoredExpandThoughts();
    current = stored;
    store.set(stored);
  }

  return { expanded: store, setExpanded, toggle, init };
}

export const expandThoughtsStore = createExpandThoughtsStore();
