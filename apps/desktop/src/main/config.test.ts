import { describe, expect, it } from 'vitest';

import { DEFAULT_PWA_URL, resolvePwaUrl } from './config';

describe('resolvePwaUrl', () => {
  it('defaults to the production PWA origin when no override is set', () => {
    expect(resolvePwaUrl({ env: {} })).toBe(DEFAULT_PWA_URL);
    expect(resolvePwaUrl({ env: {} })).toBe('https://app.loombox.dev');
  });

  it('uses LOOMBOX_DESKTOP_PWA_URL when set, for local dev against the PWA dev server', () => {
    expect(resolvePwaUrl({ env: { LOOMBOX_DESKTOP_PWA_URL: 'http://localhost:5173' } })).toBe(
      'http://localhost:5173',
    );
  });

  it('ignores a blank override and falls back to the default', () => {
    expect(resolvePwaUrl({ env: { LOOMBOX_DESKTOP_PWA_URL: '   ' } })).toBe(DEFAULT_PWA_URL);
  });

  it('falls back to process.env when no env override is passed', () => {
    // No assertion on a specific value here (the real process.env is
    // whatever the test runner's shell has) — just proves the default
    // parameter path doesn't throw and returns a non-empty string.
    expect(resolvePwaUrl()).toBeTruthy();
  });
});
