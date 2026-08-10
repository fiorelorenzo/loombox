/**
 * Local persistence for per-project mute and quiet-hours settings (issue
 * #166; SPEC.md §7.11). #282 moved the pure decision types/functions
 * (`NotificationPreferences`, `defaultNotificationPreferences`,
 * `isProjectMuted`, `isWithinQuietHours`, ...) to `@loombox/push-core` so
 * `apps/mobile`'s native push path can apply the exact same suppression
 * rules without duplicating them; re-exported below so every existing call
 * site in this package keeps importing them from `$lib/notification-preferences`
 * unchanged. What's left here — `localStorage`-backed read/write, the
 * Settings UI's toggle handlers — is genuinely web-only.
 *
 * Scoped to this device's local storage for this wave (not synced to the
 * account via the relay — the relay is out of this wave's SCOPE; `main`
 * ships a real account-wide sync as later work). Same injectable-storage
 * pattern as `device-id-store.ts`/`amk-store.ts`: every real browser API
 * this module touches (`localStorage`) is a constructor parameter with a
 * real-browser default, so it is unit-testable in the `node` vitest
 * environment without jsdom.
 */
import {
  defaultNotificationPreferences,
  type NotificationPreferences,
  type QuietHoursWindow,
} from '@loombox/push-core';

export {
  defaultNotificationPreferences,
  isProjectMuted,
  isWithinQuietHours,
  type NotificationPreferences,
  type QuietHoursWindow,
} from '@loombox/push-core';

export interface NotificationPreferencesStorage {
  get(): NotificationPreferences;
  set(prefs: NotificationPreferences): void;
}

const STORAGE_KEY = 'loombox:notification-preferences';

/** The real, `window.localStorage`-backed storage (browser + jsdom). Malformed/absent stored JSON falls back to the defaults rather than throwing — a corrupted value should degrade to "no preferences set", not break the app. */
export function createLocalStorageNotificationPreferencesStorage(
  storage: Storage = globalThis.localStorage,
): NotificationPreferencesStorage {
  return {
    get() {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return defaultNotificationPreferences();
      try {
        const parsed = JSON.parse(raw) as Partial<NotificationPreferences>;
        return {
          mutedProjects: Array.isArray(parsed.mutedProjects) ? parsed.mutedProjects : [],
          quietHours: parsed.quietHours ?? undefined,
        };
      } catch {
        return defaultNotificationPreferences();
      }
    },
    set(prefs) {
      storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    },
  };
}

/** An in-memory `NotificationPreferencesStorage` — SSR (no `localStorage`) and hermetic tests. */
export function createInMemoryNotificationPreferencesStorage(): NotificationPreferencesStorage {
  let current = defaultNotificationPreferences();
  return {
    get: () => current,
    set: (prefs) => {
      current = prefs;
    },
  };
}

/** Toggles one project's mute state and persists the result. */
export function setProjectMuted(
  storage: NotificationPreferencesStorage,
  projectPath: string,
  muted: boolean,
): NotificationPreferences {
  const current = storage.get();
  const withoutProject = current.mutedProjects.filter((path) => path !== projectPath);
  const next: NotificationPreferences = {
    ...current,
    mutedProjects: muted ? [...withoutProject, projectPath] : withoutProject,
  };
  storage.set(next);
  return next;
}

/** Sets (or clears, with `undefined`) the quiet-hours window and persists the result. */
export function setQuietHours(
  storage: NotificationPreferencesStorage,
  quietHours: QuietHoursWindow | undefined,
): NotificationPreferences {
  const next: NotificationPreferences = { ...storage.get(), quietHours };
  storage.set(next);
  return next;
}
