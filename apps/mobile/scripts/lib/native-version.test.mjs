import { describe, expect, it } from 'vitest';
import { deriveNativeVersion } from './native-version.mjs';

describe('deriveNativeVersion', () => {
  it("packs a real released version (0.9.0, @loombox/web's current tag) into a positive versionCode", () => {
    expect(deriveNativeVersion('0.9.0')).toEqual({ name: '0.9.0', code: 9000 });
  });

  it('preserves semver ordering across a major bump', () => {
    const a = deriveNativeVersion('0.9.0');
    const b = deriveNativeVersion('1.0.0');
    expect(b.code).toBeGreaterThan(a.code);
  });

  it('preserves semver ordering across a minor bump within the same major', () => {
    const a = deriveNativeVersion('1.2.9');
    const b = deriveNativeVersion('1.3.0');
    expect(b.code).toBeGreaterThan(a.code);
  });

  it('preserves semver ordering across a patch bump', () => {
    const a = deriveNativeVersion('1.2.3');
    const b = deriveNativeVersion('1.2.4');
    expect(b.code).toBeGreaterThan(a.code);
  });

  it('rejects 0.0.0 (the unreleased-package sentinel) rather than emitting versionCode 0', () => {
    expect(() => deriveNativeVersion('0.0.0')).toThrow(/non-positive versionCode/);
  });

  it('rejects a minor or patch component that would overflow the fixed-width packing', () => {
    expect(() => deriveNativeVersion('1.1000.0')).toThrow(/preserve semver ordering/);
    expect(() => deriveNativeVersion('1.0.1000')).toThrow(/preserve semver ordering/);
  });

  it('rejects a non-semver string outright rather than silently producing NaN', () => {
    expect(() => deriveNativeVersion('not-a-version')).toThrow(/is not a semver string/);
  });

  it('tolerates a prerelease/build suffix by reading only the leading major.minor.patch', () => {
    expect(deriveNativeVersion('2.1.0-beta.1')).toEqual({ name: '2.1.0', code: 2001000 });
  });
});
