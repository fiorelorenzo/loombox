import { writable, type Readable } from 'svelte/store';

/**
 * The thought-display preference (design spec
 * `2026-08-05-zed-parity-decisions.md` §3, decision C4-2, issue #745).
 * Extends v8's B2-1 (`2026-08-05-cockpit-v8-decisions.md` §2, issue #709)
 * from a boolean to three values rather than reversing it — still one
 * preference, still global, still read once and applied to every thought
 * in every session, persisted the same way `$lib/accent.ts`/`$lib/theme.ts`
 * persist their own (a module-level `writable`, a `readStored*`/`persist`
 * pair, and an `init()` a caller runs once client-side; see those files'
 * doc comments for why the shape looks like this).
 *
 * - `'collapsed'` — never shows a thought's body, even while it's actively
 *   producing text; only the header row's ticking timer and woven-thread
 *   motif say anything is happening. New: this "never, period" choice did
 *   not exist before this issue.
 * - `'expanded'` — always shows it, streaming or settled.
 * - `'automatic'` — the default (C4-2's own pick): expanded while the
 *   thought is producing text, collapsed to one line the instant real
 *   message content starts arriving for that turn. This is exactly what
 *   the old boolean's `false` used to mean (`displayExpanded = pref ||
 *   thinking`, issue #660's fix) — see `migrateLegacyBoolean` below for why
 *   `false` migrates to `'automatic'`, not `'collapsed'`.
 *
 * A thought a user expands by hand must stay expanded for that thought,
 * including through `'automatic'`'s own settle-on-real-content transition
 * (issue #661). That per-thought override lives in `MessageItem.svelte` as
 * plain component state, not here: it is not a preference — nothing
 * persists, nothing sets a future thought's default — just interaction
 * memory for the one already-mounted thought the user clicked, which is
 * why keeping a single global mode here does not conflict with honoring
 * it.
 */
export type ThoughtDisplayMode = 'collapsed' | 'expanded' | 'automatic';

const STORAGE_KEY = 'loombox:expand-thoughts';

/** C4-2's own pick. */
export const DEFAULT_THOUGHT_DISPLAY_MODE: ThoughtDisplayMode = 'automatic';

function isThoughtDisplayMode(value: string): value is ThoughtDisplayMode {
  return value === 'collapsed' || value === 'expanded' || value === 'automatic';
}

/**
 * Maps a pre-#745 boolean ('true'/'false', the entire alphabet of the old
 * two-state preference) onto the three-state value with the SAME visible
 * behavior, not the textually-closest name: `'true'` (always expanded) is
 * unambiguous, but `'false'` behaviorally meant "collapsed once settled,
 * forced visible while producing" (issue #660's fix) — that is what
 * `'automatic'` is now called, not the new, stricter `'collapsed'`, which
 * never existed as an option before this migration. Mapping `'false'` to
 * `'collapsed'` would silently strip streaming visibility from an existing
 * user who never asked for that. Any other stored value is not a legacy
 * boolean at all (corrupt, or a future format); the caller falls back to
 * the default for it.
 */
function migrateLegacyBoolean(raw: string): ThoughtDisplayMode | undefined {
  if (raw === 'true') return 'expanded';
  if (raw === 'false') return 'automatic';
  return undefined;
}

/**
 * Reads the persisted preference, defaulting to `'automatic'` — SSR/non-
 * browser-safe (no `localStorage` during SSR renders). `migrated` is true
 * only when the stored value was a pre-#745 boolean, so `init()` below can
 * write the migrated value back once and stop re-migrating on every future
 * load.
 */
function readStoredThoughtDisplayMode(): { mode: ThoughtDisplayMode; migrated: boolean } {
  if (typeof localStorage === 'undefined') {
    return { mode: DEFAULT_THOUGHT_DISPLAY_MODE, migrated: false };
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return { mode: DEFAULT_THOUGHT_DISPLAY_MODE, migrated: false };
  if (isThoughtDisplayMode(raw)) return { mode: raw, migrated: false };
  const legacy = migrateLegacyBoolean(raw);
  return legacy
    ? { mode: legacy, migrated: true }
    : { mode: DEFAULT_THOUGHT_DISPLAY_MODE, migrated: false };
}

/**
 * The app-wide thought-display-mode store — a single module-level
 * instance, same shape as `accent.ts`'s/`theme.ts`'s own stores.
 */
function createExpandThoughtsStore(): {
  mode: Readable<ThoughtDisplayMode>;
  setMode: (mode: ThoughtDisplayMode) => void;
  /** Applies the currently-stored preference — call once, client-side, on app startup (mirrors `theme.ts`'s/`accent.ts`'s `init()`). */
  init: () => void;
} {
  const store = writable<ThoughtDisplayMode>(DEFAULT_THOUGHT_DISPLAY_MODE);

  function persist(mode: ThoughtDisplayMode): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, mode);
  }

  function setMode(mode: ThoughtDisplayMode): void {
    store.set(mode);
    persist(mode);
  }

  function init(): void {
    const { mode, migrated } = readStoredThoughtDisplayMode();
    store.set(mode);
    // Rewrites a migrated legacy boolean into its new three-state form
    // immediately, so the raw 'true'/'false' string doesn't linger in
    // localStorage and get silently re-migrated (harmlessly, but
    // pointlessly) on every future init(). A brand-new user with nothing
    // stored is left alone here, same as theme.ts/accent.ts never writing
    // until the user actually makes a choice.
    if (migrated) persist(mode);
  }

  return { mode: store, setMode, init };
}

export const expandThoughtsStore = createExpandThoughtsStore();
