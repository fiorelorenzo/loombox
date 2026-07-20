/**
 * Per-project mute and quiet-hours settings (SPEC.md §7.11 "Per-project mute
 * and quiet-hours let the user tune what interrupts them", issue #166).
 * Scoped to this device's local storage for this wave (not synced to the
 * account via the relay — the relay is out of this wave's SCOPE; `main`
 * ships a real account-wide sync as later work). Same injectable-storage
 * pattern as `device-id-store.ts`/`amk-store.ts`: every real browser API
 * this module touches (`localStorage`) is a constructor parameter with a
 * real-browser default, so it is unit-testable in the `node` vitest
 * environment without jsdom.
 *
 * "Project" here is `ClientSessionMeta.projectPath` (`relay-client.ts`) —
 * v1 has no separate project entity yet; every session already carries the
 * decrypted `projectPath` its mute setting keys off.
 */

export interface QuietHoursWindow {
  /** 24h local time, `"HH:MM"`. */
  start: string;
  /** 24h local time, `"HH:MM"`. May be numerically before `start` — an overnight window (e.g. `22:00`-`07:00`) wraps past midnight. */
  end: string;
}

export interface NotificationPreferences {
  /** `projectPath`s currently muted — suppressed until removed from this list. */
  mutedProjects: string[];
  /** `undefined` means no quiet-hours window is set (never suppresses). */
  quietHours: QuietHoursWindow | undefined;
}

export function defaultNotificationPreferences(): NotificationPreferences {
  return { mutedProjects: [], quietHours: undefined };
}

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

export function isProjectMuted(prefs: NotificationPreferences, projectPath: string): boolean {
  return prefs.mutedProjects.includes(projectPath);
}

/** `"HH:MM"` -> minutes since local midnight. Returns `undefined` for a malformed value rather than throwing — a corrupted stored window should fail open (never suppress), not crash the notification path. */
function minutesSinceMidnight(time: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/**
 * Whether `now` falls inside the configured quiet-hours window, in the
 * browser's own local time (the same zone the user set the window in).
 * Handles an overnight window that wraps past midnight (`start > end`,
 * e.g. `22:00`-`07:00`): the window is "on" whenever the current time is at
 * or after `start` OR before `end`, rather than the impossible
 * `start <= now < end` an same-day-only check would require. A same-day
 * window (`start <= end`) uses the ordinary inclusive-start/exclusive-end
 * check. No window configured, or a malformed one, never suppresses.
 */
export function isWithinQuietHours(
  prefs: NotificationPreferences,
  now: Date = new Date(),
): boolean {
  if (!prefs.quietHours) return false;
  const start = minutesSinceMidnight(prefs.quietHours.start);
  const end = minutesSinceMidnight(prefs.quietHours.end);
  if (start === undefined || end === undefined) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false; // a zero-length window never suppresses
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}
