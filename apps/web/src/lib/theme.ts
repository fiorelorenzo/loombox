import { writable, type Readable } from 'svelte/store';

/**
 * The design tokens' theme mechanism (issue #195, SPEC.md §4 "dark-mode-
 * first"): `'system'` means "no explicit choice yet, follow
 * `prefers-color-scheme`" — `tokens.css`'s `@media (prefers-color-scheme:
 * light) { :root:not([data-theme]) { ... } }` block handles that case
 * entirely in CSS, so `'system'` is expressed as the *absence* of a
 * `data-theme` attribute on `<html>`, not as an explicit third value the
 * DOM ever sees. `'dark'`/`'light'` are an explicit, persisted user
 * override that always wins over the media query (`tokens.css`'s
 * `[data-theme="light"]` selector is more specific and, for the dark case,
 * simply matches the already-default `:root` values).
 */
export type ThemePreference = 'system' | 'dark' | 'light';

const STORAGE_KEY = 'loombox:theme';

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'dark' || value === 'light';
}

/** Reads the persisted preference, defaulting to `'system'` — SSR/non-browser-safe (no `localStorage` during `routes/page.test.ts`'s SSR render). */
function readStoredPreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system';
  const stored = localStorage.getItem(STORAGE_KEY);
  return isThemePreference(stored) ? stored : 'system';
}

/** Stamps (or clears) `data-theme` on `<html>` — the one DOM effect every token in `tokens.css` reacts to. SSR/non-browser-safe. */
function applyThemeAttribute(preference: ThemePreference): void {
  if (typeof document === 'undefined') return;
  if (preference === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', preference);
  }
}

/**
 * The app-wide theme preference store. A single module-level instance
 * (like `relay-client.ts`'s pattern elsewhere in this package) since
 * there's exactly one `<html>` to stamp, not one per component.
 */
function createThemeStore(): {
  preference: Readable<ThemePreference>;
  setTheme: (preference: ThemePreference) => void;
  toggleTheme: () => void;
  /** Applies the currently-stored preference to the DOM — call once, client-side, on app startup (mirrors `amk-store.ts`'s "load once in onMount" shape). */
  init: () => void;
} {
  const store = writable<ThemePreference>('system');

  function setTheme(preference: ThemePreference): void {
    store.set(preference);
    applyThemeAttribute(preference);
    if (typeof localStorage === 'undefined') return;
    if (preference === 'system') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, preference);
    }
  }

  function toggleTheme(): void {
    let current: ThemePreference = 'system';
    const unsubscribe = store.subscribe((value) => (current = value));
    unsubscribe();

    // Cycling from 'system' starts at the opposite of whatever it's
    // currently resolving to, so the very first tap always visibly flips
    // the theme rather than possibly matching what's already on screen.
    const resolvedSystem: ThemePreference =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    const startingFrom = current === 'system' ? resolvedSystem : current;
    setTheme(startingFrom === 'dark' ? 'light' : 'dark');
  }

  function init(): void {
    const stored = readStoredPreference();
    store.set(stored);
    applyThemeAttribute(stored);
  }

  return { preference: store, setTheme, toggleTheme, init };
}

export const themeStore = createThemeStore();
