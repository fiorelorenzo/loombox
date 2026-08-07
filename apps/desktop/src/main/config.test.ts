import { describe, expect, it } from 'vitest';

import { resolveDesktopEnvironmentConfig } from './environment';
import { DEFAULT_PWA_URL, PWA_URL_FLAG, resolvePwaUrl } from './config';

describe('resolvePwaUrl', () => {
  it('defaults to the production PWA origin when no override is set', () => {
    expect(resolvePwaUrl({ env: {}, argv: [] })).toBe(DEFAULT_PWA_URL);
    expect(resolvePwaUrl({ env: {}, argv: [] })).toBe('https://app.loombox.dev');
  });

  it('uses LOOMBOX_DESKTOP_PWA_URL when set, for local dev against the PWA dev server', () => {
    expect(
      resolvePwaUrl({ env: { LOOMBOX_DESKTOP_PWA_URL: 'http://localhost:5173' }, argv: [] }),
    ).toBe('http://localhost:5173');
  });

  it('ignores a blank override and falls back to the default', () => {
    expect(resolvePwaUrl({ env: { LOOMBOX_DESKTOP_PWA_URL: '   ' }, argv: [] })).toBe(
      DEFAULT_PWA_URL,
    );
  });

  // The argv flag is the override that actually survives an SSH-driven launch:
  // `launchctl setenv` does not reach a LaunchServices-started app on macOS 26,
  // but `open --args` does. See `resolvePwaUrl`'s doc comment.
  it('uses --pwa-url= from argv, the override that survives a remote GUI launch', () => {
    expect(
      resolvePwaUrl({
        env: {},
        argv: ['/path/Electron', '/repo/apps/desktop', `${PWA_URL_FLAG}http://100.64.0.1:5173`],
      }),
    ).toBe('http://100.64.0.1:5173');
  });

  it('lets the argv flag win over the env var, so an explicit launch beats a stale exported value', () => {
    expect(
      resolvePwaUrl({
        env: { LOOMBOX_DESKTOP_PWA_URL: 'http://stale.example:5173' },
        argv: [`${PWA_URL_FLAG}http://fresh.example:5173`],
      }),
    ).toBe('http://fresh.example:5173');
  });

  it('ignores a blank argv flag rather than loading an empty URL', () => {
    expect(resolvePwaUrl({ env: {}, argv: [`${PWA_URL_FLAG}   `] })).toBe(DEFAULT_PWA_URL);
  });

  it('is unbothered by the other flags a debug launch passes', () => {
    expect(
      resolvePwaUrl({
        env: {},
        argv: ['--remote-debugging-port=9222', '--inspect=9229', `${PWA_URL_FLAG}http://x:1`],
      }),
    ).toBe('http://x:1');
  });

  it('defaults to the preview PWA origin when LOOMBOX_DESKTOP_ENV=preview and no explicit override is set — issue #866: preview points at preview.loombox.dev, not production', () => {
    expect(resolvePwaUrl({ env: { LOOMBOX_DESKTOP_ENV: 'preview' }, argv: [] })).toBe(
      'https://preview.loombox.dev',
    );
    expect(resolvePwaUrl({ env: { LOOMBOX_DESKTOP_ENV: 'preview' }, argv: [] })).toBe(
      resolveDesktopEnvironmentConfig({ env: { LOOMBOX_DESKTOP_ENV: 'preview' } }).defaultPwaUrl,
    );
  });

  it('still lets LOOMBOX_DESKTOP_PWA_URL override the preview default, e.g. for local dev against the PWA dev server while packaged as a preview build', () => {
    expect(
      resolvePwaUrl({
        env: { LOOMBOX_DESKTOP_ENV: 'preview', LOOMBOX_DESKTOP_PWA_URL: 'http://localhost:5173' },
        argv: [],
      }),
    ).toBe('http://localhost:5173');
  });

  it('still lets the argv flag override the preview default', () => {
    expect(
      resolvePwaUrl({
        env: { LOOMBOX_DESKTOP_ENV: 'preview' },
        argv: [`${PWA_URL_FLAG}http://100.64.0.1:5173`],
      }),
    ).toBe('http://100.64.0.1:5173');
  });

  it('falls back to process.env/process.argv when neither is passed', () => {
    // No assertion on a specific value here (the real process env/argv are
    // whatever the test runner's shell has) — just proves the default
    // parameter path doesn't throw and returns a non-empty string.
    expect(resolvePwaUrl()).toBeTruthy();
  });
});
