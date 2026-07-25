import { writable, type Readable } from 'svelte/store';

/**
 * The Style-system mechanism (redesign v2 design spec §1, issue #458):
 * `Style` is one of three full visual languages a user picks in Appearance,
 * orthogonal to `theme.ts`'s dark/light axis and `accent.ts`'s accent
 * axis — see `$lib/styles/tokens.css`'s doc comment for how the three
 * layer. Unlike `ThemePreference`, there is no `'system'` value here: Deck
 * is simply the default, and every explicit choice (including re-selecting
 * Deck) is stamped and persisted the same way, so `<html>` always carries a
 * concrete `data-style` once this module's `init()` has run client-side.
 */
export type StylePreference = 'deck' | 'loom' | 'studio';

const STORAGE_KEY = 'loombox:style';

const DEFAULT_STYLE: StylePreference = 'deck';

function isStylePreference(value: string | null): value is StylePreference {
  return value === 'deck' || value === 'loom' || value === 'studio';
}

/** Reads the persisted preference, defaulting to `'deck'` — SSR/non-browser-safe (no `localStorage` during SSR renders). */
function readStoredPreference(): StylePreference {
  if (typeof localStorage === 'undefined') return DEFAULT_STYLE;
  const stored = localStorage.getItem(STORAGE_KEY);
  return isStylePreference(stored) ? stored : DEFAULT_STYLE;
}

/** Stamps `data-style` on `<html>` — the one DOM effect every Style's CSS file (`deck.css`/`loom.css`/`studio.css`) reacts to. SSR/non-browser-safe. */
function applyStyleAttribute(preference: StylePreference): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-style', preference);
}

/**
 * The app-wide Style preference store. A single module-level instance
 * (mirrors `theme.ts`'s `createThemeStore` pattern) since there's exactly
 * one `<html>` to stamp, not one per component.
 */
function createStyleStore(): {
  preference: Readable<StylePreference>;
  setStyle: (preference: StylePreference) => void;
  /** Applies the currently-stored preference to the DOM — call once, client-side, on app startup (mirrors `theme.ts`'s `init()`). */
  init: () => void;
} {
  const store = writable<StylePreference>(DEFAULT_STYLE);

  function setStyle(preference: StylePreference): void {
    store.set(preference);
    applyStyleAttribute(preference);
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, preference);
  }

  function init(): void {
    const stored = readStoredPreference();
    store.set(stored);
    applyStyleAttribute(stored);
  }

  return { preference: store, setStyle, init };
}

export const styleStore = createStyleStore();
