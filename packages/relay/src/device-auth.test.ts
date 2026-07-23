import { describe, expect, it } from 'vitest';

import {
  generateDeviceCode,
  generateDeviceTokenSecret,
  generateUserCode,
  hashDeviceSecret,
  normalizeUserCode,
} from './device-auth';

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
});
