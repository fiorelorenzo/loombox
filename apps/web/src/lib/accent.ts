import { writable, type Readable } from 'svelte/store';
import { deriveAccentPalette } from './accent-color';
import { ACCENT_PRESETS, isAccentPresetKey, type AccentPresetKey } from './accent-presets';
import { themeStore, type ThemePreference } from './theme';

/**
 * The accent-theming mechanism (issue #376, SPEC.md §4's "thread" accent).
 * A selection is either one of the six built-in presets or a user-typed
 * custom hex; either way it resolves, per {@link applyAccentAttributes},
 * to the same five `--color-accent*` custom properties `tokens.css`
 * defines, set as *inline* styles on `<html>` — which is what lets a
 * custom hex win outright regardless of theme (inline styles beat any
 * selector), while a preset still recomputes correctly whenever the
 * resolved theme ground changes.
 *
 * The ground (dark/light) a preset resolves against is tracked from two
 * inputs kept in sync below, deliberately *not* by re-reading
 * `document.documentElement`'s `data-theme` attribute at apply time:
 * `theme.ts`'s `setTheme` notifies its store's subscribers (synchronous,
 * via `svelte/store`) *before* it stamps the DOM attribute, so a same-tick
 * DOM read from inside a subscriber would see the *previous* theme. Instead
 * this module subscribes to `themeStore.preference` directly (its
 * callback's argument is the new value itself, no DOM read needed) and
 * tracks the OS `prefers-color-scheme` match from the `matchMedia` change
 * event's own `matches` field.
 */
export type AccentSelection =
  { type: 'preset'; key: AccentPresetKey } | { type: 'custom'; hex: string };

const STORAGE_KEY = 'loombox:accent';

export const DEFAULT_ACCENT_SELECTION: AccentSelection = { type: 'preset', key: 'azure' };

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** A strict `#rrggbb` check — the shape `<input type="color">` always emits, and the only shape `deriveAccentPalette` is asked to accept from user input. */
export function isValidAccentHex(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

function isAccentSelection(value: unknown): value is AccentSelection {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'preset') return isAccentPresetKey(record.key);
  if (record.type === 'custom')
    return typeof record.hex === 'string' && isValidAccentHex(record.hex);
  return false;
}

/** Reads the persisted selection, defaulting to azure — SSR/non-browser-safe (no `localStorage` during SSR renders). */
function readStoredSelection(): AccentSelection {
  if (typeof localStorage === 'undefined') return DEFAULT_ACCENT_SELECTION;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_ACCENT_SELECTION;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isAccentSelection(parsed) ? parsed : DEFAULT_ACCENT_SELECTION;
  } catch {
    return DEFAULT_ACCENT_SELECTION;
  }
}

type ThemeGround = 'dark' | 'light';

/** `'system'` resolves off the last-known OS match; `'dark'`/`'light'` is a direct, explicit choice — mirrors `tokens.css`'s own two ways in (`theme.ts`'s doc comment). */
function groundForPreference(
  preference: ThemePreference,
  systemPrefersLight: boolean,
): ThemeGround {
  if (preference === 'dark' || preference === 'light') return preference;
  return systemPrefersLight ? 'light' : 'dark';
}

function baseHexFor(selection: AccentSelection, ground: ThemeGround): string {
  if (selection.type === 'custom') return selection.hex;
  return ACCENT_PRESETS[selection.key][ground];
}

/** Stamps the derived palette as inline `--color-accent*` properties on `<html>`, plus a `data-accent` attribute (the selected preset key, or `'custom'`) mirroring `theme.ts`'s `data-theme` for anything that wants to style off the current selection. SSR/non-browser-safe. */
function applyAccentAttributes(selection: AccentSelection, ground: ThemeGround): void {
  if (typeof document === 'undefined') return;
  const palette = deriveAccentPalette(baseHexFor(selection, ground));
  const style = document.documentElement.style;
  style.setProperty('--color-accent', palette.accent);
  style.setProperty('--color-accent-hover', palette.hover);
  style.setProperty('--color-accent-active', palette.active);
  style.setProperty('--color-accent-subtle', palette.subtle);
  style.setProperty('--color-accent-contrast', palette.contrast);
  document.documentElement.setAttribute(
    'data-accent',
    selection.type === 'preset' ? selection.key : 'custom',
  );
}

/**
 * The app-wide accent selection store — a single module-level instance,
 * same shape as `theme.ts`'s `themeStore`.
 */
function createAccentStore(): {
  selection: Readable<AccentSelection>;
  setPreset: (key: AccentPresetKey) => void;
  setCustom: (hex: string) => void;
  /** Applies the currently-stored selection to the DOM and starts tracking theme-ground changes — call once, client-side, on app startup (mirrors `theme.ts`'s `init()`). */
  init: () => void;
} {
  const store = writable<AccentSelection>(DEFAULT_ACCENT_SELECTION);
  let current: AccentSelection = DEFAULT_ACCENT_SELECTION;
  let themePreference: ThemePreference = 'system';
  let systemPrefersLight = false;
  let unsubscribeTheme: (() => void) | undefined;
  let mediaQuery: MediaQueryList | undefined;
  let onMediaChange: ((event: MediaQueryListEvent) => void) | undefined;

  function currentGround(): ThemeGround {
    return groundForPreference(themePreference, systemPrefersLight);
  }

  function persist(selection: AccentSelection): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  }

  function set(selection: AccentSelection): void {
    current = selection;
    store.set(selection);
    applyAccentAttributes(selection, currentGround());
    persist(selection);
  }

  function setPreset(key: AccentPresetKey): void {
    set({ type: 'preset', key });
  }

  function setCustom(hex: string): void {
    set({ type: 'custom', hex });
  }

  function init(): void {
    const stored = readStoredSelection();
    current = stored;
    store.set(stored);

    systemPrefersLight =
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-color-scheme: light)').matches;

    // `subscribe` invokes its callback synchronously with the *current*
    // value the instant it's called, so this one subscription both applies
    // the initial ground and tracks every later explicit theme change —
    // see this file's top doc comment for why the callback's own argument
    // (not a `data-theme` DOM read) is the ground-of-record.
    unsubscribeTheme?.();
    unsubscribeTheme = themeStore.preference.subscribe((preference) => {
      themePreference = preference;
      applyAccentAttributes(current, currentGround());
    });

    if (typeof window !== 'undefined' && window.matchMedia) {
      if (mediaQuery && onMediaChange) mediaQuery.removeEventListener('change', onMediaChange);
      mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
      onMediaChange = (event: MediaQueryListEvent) => {
        systemPrefersLight = event.matches;
        applyAccentAttributes(current, currentGround());
      };
      mediaQuery.addEventListener('change', onMediaChange);
    }
  }

  return { selection: store, setPreset, setCustom, init };
}

export const accentStore = createAccentStore();
