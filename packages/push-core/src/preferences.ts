/**
 * Per-project mute and quiet-hours settings — the pure decision types and
 * functions (SPEC.md §7.11 "Per-project mute and quiet-hours let the user
 * tune what interrupts them", issue #166), extracted from `apps/web`'s
 * `notification-preferences.ts` by #282 so `apps/mobile`'s native push path
 * can apply the exact same suppression rules the web Push path already
 * does. The persistence side (`localStorage`-backed read/write, the
 * Settings UI's toggle handlers) is web-UI-specific and stays in
 * `apps/web/src/lib/notification-preferences.ts`, which re-exports these.
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
 * device's own local time (the same zone the user set the window in).
 * Handles an overnight window that wraps past midnight (`start > end`,
 * e.g. `22:00`-`07:00`): the window is "on" whenever the current time is at
 * or after `start` OR before `end`, rather than the impossible
 * `start <= now < end` a same-day-only check would require. A same-day
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
