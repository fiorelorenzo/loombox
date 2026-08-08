import { writable } from 'svelte/store';

import type { BuildIdentityV1 } from '@loombox/protocol';

/**
 * The PWA's "a new version is ready" signal (issue #657's remaining PWA
 * half, #924 shipped the relay/desktop update paths and the compatibility
 * window, leaving this and migration reversibility open, see #657's own
 * comment thread).
 *
 * Two independent triggers feed `+page.svelte`'s own `staleBuild`
 * `$derived` (which drives whether `UpdateAvailableToast` renders):
 *
 * - The service worker's own update check (`registerServiceWorkerUpdater`,
 *   wired from `+layout.svelte`'s `useRegisterSW`). `vite.config.ts` used
 *   to run `registerType: 'autoUpdate'`, which, per `vite-plugin-pwa`'s
 *   own source (`registerSW.ts`'s `auto` branch), calls a bare
 *   `window.location.reload()` the instant a new service worker activates,
 *   with no `onNeedReload` override: a forced reload mid-turn, exactly
 *   what this issue's acceptance says is worse than the drift it was
 *   trying to fix. `registerType: 'prompt'` (now) instead only sets a flag
 *   and waits for a real user click.
 * - `bundleIsStale` below, comparing this tab's OWN build (`$app/
 *   environment`'s `version`, baked in at build time from
 *   `LOOMBOX_BUILD_COMMIT`, see `svelte.config.js`) against what the
 *   relay is CURRENTLY serving (`RelayClient.relayBuildIdentity`, issue
 *   #655's build identity, arriving over the already-open connection on
 *   every connect/reconnect). This is the one #657's own brief points at
 *   ("#655 already announces build identity across the protocol, so the
 *   client can know") and it catches what the service worker's own
 *   opportunistic update check can miss: a browser only checks for a new
 *   service worker around navigation, so a long-lived, no-navigation
 *   session (this app's own normal shape, an open agent session can run
 *   for hours) might not hear from it for a long time. It also generalizes
 *   to the Electron desktop shell's webview, which never registers a
 *   service worker at all (`+layout.svelte`'s own Electron branch).
 *
 * Either trigger reloads the SAME way: a real user click on
 * `UpdateAvailableToast`'s Reload button, never a timer, never automatic.
 */
export const pwaUpdateAvailable = writable(false);

/** Set once, by `+layout.svelte`, to vite-pwa's own `updateServiceWorker`, absent entirely inside Electron, where the service worker is never registered (see this file's own doc comment). */
let applyServiceWorkerUpdate: ((reloadPage?: boolean) => Promise<void>) | undefined;

/** Wires the service-worker-update trigger, call once, client-side, from `+layout.svelte`'s non-Electron branch. */
export function registerServiceWorkerUpdater(
  updateFn: (reloadPage?: boolean) => Promise<void>,
): void {
  applyServiceWorkerUpdate = updateFn;
}

/**
 * Applies whichever "new version" signal fired. Only ever called from a
 * real click (`UpdateAvailableToast`'s Reload button), see this file's
 * own doc comment for why that matters. A waiting service worker gets
 * skip-waiting + reload through vite-pwa's own `updateServiceWorker`; the
 * buildIdentity-only case (no service worker involved, or the Electron
 * shell, which never registers one) has nothing to hand control to, so a
 * plain reload already fetches the current bundle.
 */
export async function applyUpdate(): Promise<void> {
  if (applyServiceWorkerUpdate) {
    await applyServiceWorkerUpdate(true);
    return;
  }
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}

/**
 * Whether this tab's own bundle (`localCommit`, `$app/environment`'s
 * `version`) no longer matches what the relay is currently serving
 * (`relayBuildIdentity.commit`), this file's own doc comment covers why
 * this is a separate predicate from `relay-client.ts`'s
 * `buildIdentityMismatch`, not a reuse of it: that function's contract is
 * NODE-vs-RELAY only, and falls back to comparing `.version` when either
 * side lacks a `.commit`, this tab's own `localCommit` is always
 * commit-shaped in a real deploy (or a `vite dev`/no-env-var timestamp in
 * local dev, never a semver), so comparing it against the relay's semver
 * `.version` field would read as "stale" on every real deploy, a false
 * positive `buildIdentityMismatch` was never built to guard against.
 *
 * Absence on either side (a `vite dev` build with no `LOOMBOX_BUILD_COMMIT`,
 * a relay predating issue #655, or no handshake yet) is "unknown", never
 * read as stale, the same convention `buildIdentityMismatch` itself
 * documents.
 */
export function bundleIsStale(
  localCommit: string | undefined,
  relayBuildIdentity: BuildIdentityV1 | undefined,
): boolean {
  const relayCommit = relayBuildIdentity?.commit;
  if (!localCommit || !relayCommit) return false;
  return localCommit !== relayCommit;
}
