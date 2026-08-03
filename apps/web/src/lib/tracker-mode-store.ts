/**
 * Per-project `TrackerMode`, client-side (SPEC §7.10; issue #209). Same
 * injectable-storage pattern as `mcp-server-store.ts`/`plugin-store.ts`:
 * `localStorage` is a constructor parameter with a real-browser default, so
 * this is unit-testable in the `node` vitest environment without jsdom, and
 * scoped per project path the same way those two stores are.
 *
 * **"No default silently assumed" (issue #209's actual acceptance
 * criterion) is the whole point of this module.** `TrackerModeStorage.get`
 * returns `TrackerMode | undefined`, never `TrackerMode` alone: `undefined`
 * means "this project has never had a mode chosen" (or its stored value no
 * longer re-validates against `@loombox/protocol`'s `trackerMode` schema —
 * treated the same as unset, never repaired into a guess), and it is a
 * distinct state from the explicit, persisted `{ kind: 'native' }` a user
 * can also choose. `get()` never falls back to `{ kind: 'native' }` on
 * either an absent key or a corrupted one — a consumer that needs a
 * concrete mode to proceed MUST branch on `undefined` itself and prompt the
 * user to choose, exactly as issue #212's own acceptance criterion already
 * describes ("A project with no TrackerMode set prompts the user to choose
 * native or live before any tracker UI renders"). Building that prompt is
 * #212's job; this module only makes the `undefined` branch representable
 * and persisted.
 */

import { safeParseTrackerMode, type TrackerMode } from '@loombox/protocol';

export interface TrackerModeStorage {
  get(): TrackerMode | undefined;
  set(mode: TrackerMode): void;
}

function storageKey(projectPath: string): string {
  return `loombox:tracker-mode:${projectPath}`;
}

/** The real, `window.localStorage`-backed storage (browser + jsdom), keyed per project path. Absent, unparsable, or schema-invalid stored data all degrade to `undefined` rather than throwing or coercing to a default. */
export function createLocalStorageTrackerModeStorage(
  projectPath: string,
  storage: Storage = globalThis.localStorage,
): TrackerModeStorage {
  const key = storageKey(projectPath);
  return {
    get() {
      const raw = storage.getItem(key);
      if (!raw) return undefined;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        return undefined;
      }
      const result = safeParseTrackerMode(parsedJson);
      return result.success ? result.data : undefined;
    },
    set(mode) {
      storage.setItem(key, JSON.stringify(mode));
    },
  };
}

/** An in-memory `TrackerModeStorage` — SSR (no `localStorage`) and hermetic tests. Starts unset, exactly like a project that has never had a mode chosen. */
export function createInMemoryTrackerModeStorage(): TrackerModeStorage {
  let current: TrackerMode | undefined;
  return {
    get: () => current,
    set: (mode) => {
      current = mode;
    },
  };
}
