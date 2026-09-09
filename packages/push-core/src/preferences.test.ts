import { describe, expect, it } from 'vitest';

import { isProjectMuted, isWithinQuietHours, type NotificationPreferences } from './preferences';

describe('isProjectMuted (#166)', () => {
  it('reflects the muted-projects list', () => {
    const prefs: NotificationPreferences = { mutedProjects: ['/repo/a'], quietHours: undefined };
    expect(isProjectMuted(prefs, '/repo/a')).toBe(true);
    expect(isProjectMuted(prefs, '/repo/b')).toBe(false);
  });
});

describe('isWithinQuietHours (#166)', () => {
  it('is never within quiet hours when none is configured', () => {
    const prefs: NotificationPreferences = { mutedProjects: [], quietHours: undefined };
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 23, 0))).toBe(false);
  });

  it('suppresses inside a same-day window (inclusive start, exclusive end)', () => {
    const prefs: NotificationPreferences = {
      mutedProjects: [],
      quietHours: { start: '13:00', end: '14:00' },
    };
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 13, 0))).toBe(true);
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 13, 30))).toBe(true);
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 14, 0))).toBe(false);
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 12, 59))).toBe(false);
  });

  it('suppresses across an overnight window that wraps past midnight', () => {
    const prefs: NotificationPreferences = {
      mutedProjects: [],
      quietHours: { start: '22:00', end: '07:00' },
    };
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 23, 30))).toBe(true);
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 3, 0))).toBe(true);
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 6, 59))).toBe(true);
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 7, 0))).toBe(false);
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 12, 0))).toBe(false);
  });

  it('never suppresses on a malformed stored window rather than throwing', () => {
    const prefs: NotificationPreferences = {
      mutedProjects: [],
      quietHours: { start: 'nope', end: '07:00' },
    };
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 23, 30))).toBe(false);
  });

  it('never suppresses on a zero-length window', () => {
    const prefs: NotificationPreferences = {
      mutedProjects: [],
      quietHours: { start: '09:00', end: '09:00' },
    };
    expect(isWithinQuietHours(prefs, new Date(2026, 0, 1, 9, 0))).toBe(false);
  });
});
