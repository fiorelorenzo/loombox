import { describe, expect, it } from 'vitest';

import { compareBuildVersions, compatibilityWindowV1, isBelowCompatWindow } from './compat-window';

describe('compatibilityWindowV1', () => {
  it('parses an empty object — both bounds are independently optional', () => {
    expect(compatibilityWindowV1.parse({})).toEqual({});
  });

  it('parses either bound alone, or both together', () => {
    expect(compatibilityWindowV1.parse({ minNodeVersion: '0.5.0' })).toEqual({
      minNodeVersion: '0.5.0',
    });
    expect(compatibilityWindowV1.parse({ minClientVersion: '0.5.0' })).toEqual({
      minClientVersion: '0.5.0',
    });
    expect(
      compatibilityWindowV1.parse({ minNodeVersion: '0.5.0', minClientVersion: '0.4.0' }),
    ).toEqual({ minNodeVersion: '0.5.0', minClientVersion: '0.4.0' });
  });

  it('rejects an empty-string bound rather than treating it as unset', () => {
    expect(() => compatibilityWindowV1.parse({ minNodeVersion: '' })).toThrow();
  });
});

describe('compareBuildVersions', () => {
  it('compares dotted numeric versions numerically, not lexicographically', () => {
    expect(compareBuildVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareBuildVersions('1.10.0', '1.2.0')).toBeGreaterThan(0);
    expect(compareBuildVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareBuildVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('falls back to a string compare when a segment is non-numeric, rather than coercing to 0', () => {
    // `Number.parseInt` stops at the first non-digit char rather than
    // returning NaN for a segment merely STARTING with digits (e.g.
    // '0-rc1' parses as 0) — a segment has to start non-numeric to force
    // the whole-string fallback this test actually exercises.
    expect(compareBuildVersions('1.2.rc1', '1.2.rc1')).toBe(0);
    expect(compareBuildVersions('1.2.rc1', '1.2.rc2')).toBeLessThan(0);
  });
});

describe('isBelowCompatWindow', () => {
  it('is false when no window is configured — the default, every existing relay today', () => {
    expect(isBelowCompatWindow(undefined, 'node', '0.1.0')).toBe(false);
  });

  it('is false when the peer version is unknown — unknown never reads as behind', () => {
    expect(isBelowCompatWindow({ minNodeVersion: '0.5.0' }, 'node', undefined)).toBe(false);
  });

  it('is false when no floor is set for this role, even if the other role has one', () => {
    expect(isBelowCompatWindow({ minClientVersion: '0.5.0' }, 'node', '0.1.0')).toBe(false);
  });

  it('is true when a node build is strictly below the declared floor', () => {
    expect(isBelowCompatWindow({ minNodeVersion: '0.5.0' }, 'node', '0.4.9')).toBe(true);
  });

  it('is true when a client build is strictly below the declared floor', () => {
    expect(isBelowCompatWindow({ minClientVersion: '0.5.0' }, 'client', '0.4.9')).toBe(true);
  });

  it('is false exactly at the floor — the floor itself is still served', () => {
    expect(isBelowCompatWindow({ minNodeVersion: '0.5.0' }, 'node', '0.5.0')).toBe(false);
  });

  it('is false above the floor', () => {
    expect(isBelowCompatWindow({ minNodeVersion: '0.5.0' }, 'node', '0.6.0')).toBe(false);
  });

  it('checks the node floor against a node peer even when a (looser) client floor also exists', () => {
    const window = { minNodeVersion: '0.5.0', minClientVersion: '0.1.0' };
    expect(isBelowCompatWindow(window, 'node', '0.4.0')).toBe(true);
    expect(isBelowCompatWindow(window, 'client', '0.4.0')).toBe(false);
  });
});
