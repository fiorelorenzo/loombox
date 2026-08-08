// @vitest-environment jsdom
import { get } from 'svelte/store';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { bundleIsStale, pwaUpdateAvailable } from './pwa-update';

describe('bundleIsStale (issue #657, the buildIdentity-driven half of the PWA staleness signal)', () => {
  it('is stale when this tab is running a different commit than the relay is currently serving', () => {
    expect(bundleIsStale('abc123', { version: '0.8.0', commit: 'def456' })).toBe(true);
  });

  it('is not stale when both sides agree', () => {
    expect(bundleIsStale('abc123', { version: '0.8.0', commit: 'abc123' })).toBe(false);
  });

  it('is never stale when either side is unknown, absence never reads as behind', () => {
    expect(bundleIsStale(undefined, { version: '0.8.0', commit: 'abc123' })).toBe(false);
    expect(bundleIsStale('abc123', undefined)).toBe(false);
    expect(bundleIsStale(undefined, undefined)).toBe(false);
  });

  it('is never stale against a relay with no commit at all (a relay predating issue #655)', () => {
    expect(bundleIsStale('abc123', { version: '0.8.0' })).toBe(false);
  });

  it('never falls back to comparing the relay semver .version field, a commit-shaped local build has nothing to compare there', () => {
    // A real deploy's LOOMBOX_BUILD_COMMIT is commit-shaped, never a semver
    // like the relay's own package.json version. Comparing it against
    // `.version` would false-positive on every real deploy.
    expect(bundleIsStale('0.8.0', { version: '0.8.0', commit: 'abc123' })).toBe(true);
  });
});

describe('pwaUpdateAvailable / applyUpdate (issue #657, never automatic, always a real click)', () => {
  beforeEach(() => {
    pwaUpdateAvailable.set(false);
  });

  it('starts false, no service worker update announced yet', () => {
    expect(get(pwaUpdateAvailable)).toBe(false);
  });

  it('applyUpdate hands control to the registered service-worker updater when one exists', async () => {
    // Dynamic import after resetModules: registerServiceWorkerUpdater
    // mutates module-level state with no reset export (it is set once, for
    // real, from +layout.svelte). A fresh module instance is the only way
    // to test the "nothing registered yet" starting point in isolation
    // from whatever an earlier test in this file already registered.
    vi.resetModules();
    const fresh = await import('./pwa-update');
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    fresh.registerServiceWorkerUpdater(updateServiceWorker);

    await fresh.applyUpdate();

    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it('applyUpdate falls back to a plain reload when no service worker was ever registered (the Electron shell, or a buildIdentity-only signal)', async () => {
    // Same isolation reasoning as the test above.
    vi.resetModules();
    const fresh = await import('./pwa-update');
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });

    await fresh.applyUpdate();

    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
