// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  createInMemoryAmkStorage,
  createLocalStorageAmkStorage,
  loadOrCreateAmk,
} from './amk-store';

describe('loadOrCreateAmk', () => {
  it('generates a fresh 256-bit AMK and persists it on first use', () => {
    const storage = createInMemoryAmkStorage();
    expect(storage.get('acct-1')).toBeUndefined();

    const amk = loadOrCreateAmk('acct-1', storage);

    expect(amk).toBeInstanceOf(Uint8Array);
    expect(amk.byteLength).toBe(32);
    expect(storage.get('acct-1')).toEqual(amk);
  });

  it('returns the SAME AMK on a second call for the same account (does not regenerate)', () => {
    const storage = createInMemoryAmkStorage();
    const first = loadOrCreateAmk('acct-1', storage);
    const second = loadOrCreateAmk('acct-1', storage);
    expect(second).toEqual(first);
  });

  it('gives two different accounts two different AMKs', () => {
    const storage = createInMemoryAmkStorage();
    const amkA = loadOrCreateAmk('acct-a', storage);
    const amkB = loadOrCreateAmk('acct-b', storage);
    expect(amkA).not.toEqual(amkB);
  });

  it('clear() removes the persisted AMK so the next call generates a new one', () => {
    const storage = createInMemoryAmkStorage();
    const original = loadOrCreateAmk('acct-1', storage);
    storage.clear('acct-1');
    const regenerated = loadOrCreateAmk('acct-1', storage);
    expect(regenerated).not.toEqual(original);
  });

  it('round-trips through a REAL window.localStorage (jsdom), the browser-default AmkStorage', () => {
    localStorage.clear();
    const storage = createLocalStorageAmkStorage();

    const amk = loadOrCreateAmk('acct-1', storage);

    // Persisted as base64 under a per-account key, not raw bytes.
    const raw = localStorage.getItem('loombox:amk:acct-1');
    expect(typeof raw).toBe('string');
    expect(raw).not.toBe('');

    // A fresh storage handle reading the same real localStorage recovers the identical AMK.
    const reloaded = loadOrCreateAmk('acct-1', createLocalStorageAmkStorage());
    expect(reloaded).toEqual(amk);

    localStorage.clear();
  });
});
