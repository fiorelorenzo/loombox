import { describe, expect, it } from 'vitest';

import {
  createInMemoryNotificationPreferencesStorage,
  createLocalStorageNotificationPreferencesStorage,
  defaultNotificationPreferences,
  setProjectMuted,
  setQuietHours,
  type NotificationPreferences,
} from './notification-preferences';

// `isProjectMuted`/`isWithinQuietHours` moved to `@loombox/push-core` by
// #282 — see that package's `preferences.test.ts` for their coverage. This
// file only covers what's still genuinely local: `localStorage`-backed
// persistence.

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
