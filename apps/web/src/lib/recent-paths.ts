/**
 * The directory picker's client-side "recent paths" list (SPEC §7.25's
 * directory picker, design spec §3.1's "recent-paths dropdown (pure
 * client-side, from session history)"; issue #474) — a quick-pick shortcut
 * back to a project folder the user has already browsed to on a given
 * target, without another `browseDirectory()` round trip. Pure client-side
 * on purpose (mirrors `accent.ts`'s own "SSR/non-browser-safe" localStorage
 * convention): this is convenience UI state, never anything the relay/node
 * need to know about or that crosses the wire.
 *
 * Scoped per `${nodeId}:${targetId}` (a caller-supplied `scopeKey`, not
 * assembled here) — a path on one target's filesystem means nothing on
 * another, so recent paths never leak across targets/nodes the way a
 * single global list would.
 */

const STORAGE_KEY_PREFIX = 'loombox:recent-paths:';

/** How many recent paths a single scope keeps — generous enough to be useful, small enough to stay a quick glance rather than its own scrollable list. */
export const MAX_RECENT_PATHS = 8;

function storageKey(scopeKey: string): string {
  return `${STORAGE_KEY_PREFIX}${scopeKey}`;
}

/** Reads `scopeKey`'s persisted recent paths, most-recent-first — `[]` during SSR (no `localStorage`), for a missing/corrupt entry, or for one that isn't a plain string array. */
export function loadRecentPaths(scopeKey: string): string[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(storageKey(scopeKey));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/**
 * Records `path` as `scopeKey`'s most recent pick, moving it to the front if
 * already present (never a duplicate), capped at {@link MAX_RECENT_PATHS}
 * (the oldest entries fall off). A no-op (returns the unchanged list) for a
 * blank `path` — nothing meaningful to remember. Returns the resulting list
 * so a caller can update its own reactive state without a separate
 * {@link loadRecentPaths} read.
 */
export function addRecentPath(scopeKey: string, path: string): string[] {
  const trimmed = path.trim();
  const existing = loadRecentPaths(scopeKey);
  if (trimmed === '') return existing;
  const deduped = existing.filter((entry) => entry !== trimmed);
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_PATHS);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(storageKey(scopeKey), JSON.stringify(next));
  }
  return next;
}

/** Clears `scopeKey`'s recent-paths list entirely (e.g. a target being removed, issue #474's connection-management sibling). SSR/non-browser-safe, mirrors {@link addRecentPath}. */
export function clearRecentPaths(scopeKey: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(storageKey(scopeKey));
}
