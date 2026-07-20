import { describe, expect, it } from 'vitest';

import {
  createInMemoryDeviceIdStorage,
  createLocalStorageDeviceIdStorage,
  loadOrCreateDeviceId,
} from './device-id-store';

describe('loadOrCreateDeviceId (#163)', () => {
  it('generates and persists a device id on first call', () => {
    const storage = createInMemoryDeviceIdStorage();
    expect(storage.get()).toBeUndefined();

    const id = loadOrCreateDeviceId(storage, () => 'device_generated');

    expect(id).toBe('device_generated');
    expect(storage.get()).toBe('device_generated');
  });

  it('is idempotent: a later call never generates a new id', () => {
    const storage = createInMemoryDeviceIdStorage();
    const generate = () => `device_${Math.random()}`;

    const first = loadOrCreateDeviceId(storage, generate);
    const second = loadOrCreateDeviceId(storage, generate);

    expect(second).toBe(first);
  });

  it('defaults to a real generated id (non-empty, device_-prefixed) when no generator is passed', () => {
    const storage = createInMemoryDeviceIdStorage();
    const id = loadOrCreateDeviceId(storage);
    expect(id.startsWith('device_')).toBe(true);
    expect(id.length).toBeGreaterThan('device_'.length);
  });
});

describe('createLocalStorageDeviceIdStorage (#163)', () => {
  it('round-trips through a real Storage-shaped backend', () => {
    const backing = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
    } as unknown as Storage;

    const storage = createLocalStorageDeviceIdStorage(fakeStorage);
    expect(storage.get()).toBeUndefined();
    storage.set('device_abc');
    expect(storage.get()).toBe('device_abc');
    expect(backing.get('loombox:device-id')).toBe('device_abc');
  });
});
