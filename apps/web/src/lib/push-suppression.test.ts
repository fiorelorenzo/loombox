import { describe, expect, it } from 'vitest';

import {
  defaultNotificationPreferences,
  type NotificationPreferences,
} from './notification-preferences';
import { shouldSuppressPush } from './push-suppression';

describe('shouldSuppressPush (#166)', () => {
  it('never suppresses with no mutes/quiet-hours configured', () => {
    expect(
      shouldSuppressPush('sess_1', defaultNotificationPreferences(), {}, new Date(2026, 0, 1, 12)),
    ).toBe(false);
  });

  it('suppresses every session during quiet hours, regardless of project', () => {
    const prefs: NotificationPreferences = {
      mutedProjects: [],
      quietHours: { start: '22:00', end: '07:00' },
    };
    expect(shouldSuppressPush('sess_1', prefs, {}, new Date(2026, 0, 1, 23, 0))).toBe(true);
  });

  it('suppresses a session whose known project is muted', () => {
    const prefs: NotificationPreferences = { mutedProjects: ['/repo/a'], quietHours: undefined };
    const map = { sess_1: '/repo/a' };
    expect(shouldSuppressPush('sess_1', prefs, map, new Date(2026, 0, 1, 12))).toBe(true);
  });

  it('does not suppress a session whose known project is not muted', () => {
    const prefs: NotificationPreferences = { mutedProjects: ['/repo/a'], quietHours: undefined };
    const map = { sess_1: '/repo/b' };
    expect(shouldSuppressPush('sess_1', prefs, map, new Date(2026, 0, 1, 12))).toBe(false);
  });

  it('fails open (does not suppress) for a sessionId this device has no project mapping for yet', () => {
    const prefs: NotificationPreferences = { mutedProjects: ['/repo/a'], quietHours: undefined };
    expect(shouldSuppressPush('sess_unknown', prefs, {}, new Date(2026, 0, 1, 12))).toBe(false);
  });
});
