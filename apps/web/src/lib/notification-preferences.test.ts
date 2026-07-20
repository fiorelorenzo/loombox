import { describe, expect, it } from 'vitest';

import {
  createInMemoryNotificationPreferencesStorage,
  createLocalStorageNotificationPreferencesStorage,
  defaultNotificationPreferences,
  isProjectMuted,
  isWithinQuietHours,
  setProjectMuted,
  setQuietHours,
  type NotificationPreferences,
} from './notification-preferences';

describe('createInMemoryNotificationPreferencesStorage (#166)', () => {
  it('starts at the defaults and round-trips a set/get', () => {
    const storage = createInMemoryNotificationPreferencesStorage();
    expect(storage.get()).toEqual(defaultNotificationPreferences());
    const prefs: NotificationPreferences = {
      mutedProjects: ['/repo/a'],
      quietHours: { start: '22:00', end: '07:00' },
    };
    storage.set(prefs);
    expect(storage.get()).toEqual(prefs);
  });
});

describe('createLocalStorageNotificationPreferencesStorage (#166)', () => {
  function fakeLocalStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
      removeItem: (key) => void map.delete(key),
      clear: () => map.clear(),
      key: (index) => Array.from(map.keys())[index] ?? null,
      get length() {
        return map.size;
      },
    } as Storage;
  }

  it('defaults to no mutes/quiet-hours when nothing is stored yet', () => {
    const storage = createLocalStorageNotificationPreferencesStorage(fakeLocalStorage());
    expect(storage.get()).toEqual(defaultNotificationPreferences());
  });

  it('persists across calls against the same backing storage', () => {
    const backing = fakeLocalStorage();
    const first = createLocalStorageNotificationPreferencesStorage(backing);
    first.set({ mutedProjects: ['/repo/a'], quietHours: undefined });
    const second = createLocalStorageNotificationPreferencesStorage(backing);
    expect(second.get()).toEqual({ mutedProjects: ['/repo/a'], quietHours: undefined });
  });

  it('falls back to the defaults on corrupted stored JSON rather than throwing', () => {
    const backing = fakeLocalStorage();
    backing.setItem('loombox:notification-preferences', 'not json{{{');
    const storage = createLocalStorageNotificationPreferencesStorage(backing);
    expect(storage.get()).toEqual(defaultNotificationPreferences());
  });
});

describe('setProjectMuted (#166)', () => {
  it('adds a project to the mute list, without duplicating an already-muted one', () => {
    const storage = createInMemoryNotificationPreferencesStorage();
    setProjectMuted(storage, '/repo/a', true);
    const next = setProjectMuted(storage, '/repo/a', true);
    expect(next.mutedProjects).toEqual(['/repo/a']);
  });

  it('removes a project from the mute list on unmute', () => {
    const storage = createInMemoryNotificationPreferencesStorage();
    setProjectMuted(storage, '/repo/a', true);
    setProjectMuted(storage, '/repo/b', true);
    const next = setProjectMuted(storage, '/repo/a', false);
    expect(next.mutedProjects).toEqual(['/repo/b']);
  });
});

describe('setQuietHours (#166)', () => {
  it('sets and clears the quiet-hours window', () => {
    const storage = createInMemoryNotificationPreferencesStorage();
    const set = setQuietHours(storage, { start: '22:00', end: '07:00' });
    expect(set.quietHours).toEqual({ start: '22:00', end: '07:00' });
    const cleared = setQuietHours(storage, undefined);
    expect(cleared.quietHours).toBeUndefined();
  });
});

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
