import { describe, expect, it } from 'vitest';

import {
  generateDeviceCode,
  generateDeviceTokenId,
  generateDeviceTokenSecret,
  generateUserCode,
  hashDeviceSecret,
  mintDeviceToken,
  normalizeUserCode,
} from './device-auth';
import { createInMemoryRelayStore } from './store';

describe('device-auth primitives (#387)', () => {
  it('generates distinct, sufficiently long device codes and device tokens', () => {
    const a = generateDeviceCode();
    const b = generateDeviceCode();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(32);

    const tokenA = generateDeviceTokenSecret();
    const tokenB = generateDeviceTokenSecret();
    expect(tokenA).not.toBe(tokenB);
    expect(tokenA).not.toBe(a);
  });

  it('hashes deterministically, and different secrets hash differently', () => {
    const secret = generateDeviceCode();
    expect(hashDeviceSecret(secret)).toBe(hashDeviceSecret(secret));
    expect(hashDeviceSecret(secret)).not.toBe(hashDeviceSecret(generateDeviceCode()));
  });

  it('generates a user code in the XXXX-XXXX shape, from the unambiguous alphabet', () => {
    for (let i = 0; i < 20; i += 1) {
      const code = generateUserCode();
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });

  it('normalizes operator-typed input (case, whitespace, missing dash) to the stored shape', () => {
    expect(normalizeUserCode('wxyz-2345')).toBe('WXYZ-2345');
    expect(normalizeUserCode('WXYZ2345')).toBe('WXYZ-2345');
    expect(normalizeUserCode('  wxyz 2345  ')).toBe('WXYZ-2345');
  });

  it('returns cleaned-but-unformatted text for input of the wrong length, rather than throwing', () => {
    expect(() => normalizeUserCode('too-short')).not.toThrow();
    expect(normalizeUserCode('AB')).toBe('AB');
  });

  it('generates distinct device token ids', () => {
    const a = generateDeviceTokenId();
    const b = generateDeviceTokenId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });
});

describe('mintDeviceToken (#387, #398)', () => {
  it('persists only the hash of the raw token, and the raw token resolves via the store to the bound account', async () => {
    const store = createInMemoryRelayStore();
    const minted = await mintDeviceToken(store, 'acct_1', 'my node', Date.now());

    expect(minted.rawToken.length).toBeGreaterThan(32);
    expect(minted.tokenHash).toBe(hashDeviceSecret(minted.rawToken));
    expect(minted.id).toBeTruthy();

    // The raw token itself was never stored — only its hash resolves.
    expect(await store.deviceTokens.resolveByHash(minted.rawToken)).toBeUndefined();
    expect(await store.deviceTokens.resolveByHash(minted.tokenHash)).toBe('acct_1');
  });

  it('mints a distinct id/token on every call, even for the same account and label', async () => {
    const store = createInMemoryRelayStore();
    const now = Date.now();
    const first = await mintDeviceToken(store, 'acct_1', 'label', now);
    const second = await mintDeviceToken(store, 'acct_1', 'label', now);

    expect(first.id).not.toBe(second.id);
    expect(first.rawToken).not.toBe(second.rawToken);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });
});
