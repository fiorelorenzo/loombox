/// <reference lib="webworker" />

/**
 * The PWA's service worker (issues #162/#164; SPEC §7.11). `injectManifest`
 * strategy (not `generateSW`, the v0 spike's original choice — see
 * `vite.config.ts`'s comment): a `push`/`notificationclick` listener is
 * custom application logic `generateSW`'s Workbox-generated wrapper has no
 * hook for, so this file is a real, bundled entry point instead, with the
 * precache manifest injected at `self.__WB_MANIFEST` (`@vite-pwa/sveltekit`'s
 * own documented pattern). Every actual decision (what a payload means, what
 * to show, where a click goes) lives in `$lib/push-payload.ts`, a plain
 * DOM/SW-API-free module — this file is only the thin `self.addEventListener`
 * glue, mirroring the split every other browser-API surface in this package
 * already uses (`viewport.ts`, `attachments.ts`, ...).
 */
import { precacheAndRoute } from 'workbox-precaching';

import {
  focusOrOpenSession,
  parsePushPayload,
  sessionUrlFromNotificationData,
  showAttentionNotification,
  type ClientsLike,
} from '$lib/push-payload';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

// #164: the SW receives the push and shows a notification. `event.data` is
// the Web Push payload the relay sent — the small, non-sensitive routing
// hint `push.ts`'s `PushPayload` doc comment describes, never decrypted
// session content (the relay never had any to send).
self.addEventListener('push', (event: PushEvent) => {
  const payload = parsePushPayload(event.data?.json());
  if (!payload) return;
  event.waitUntil(showAttentionNotification(self.registration, payload));
});

// #164: clicking the notification opens/focuses the app at the relevant
// session (`+page.svelte` reads `?session=` on load and selects it once the
// session list arrives).
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url = sessionUrlFromNotificationData(event.notification.data as unknown);
  // `Clients.matchAll` is typed by lib.dom as returning the base `Client[]`
  // regardless of the `{ type: 'window' }` filter passed in, even though at
  // runtime it is really `WindowClient[]` (the ones with `focus`/`navigate`)
  // — this cast bridges that known lib.dom typing gap, isolated to this one
  // call site.
  event.waitUntil(focusOrOpenSession(self.clients as unknown as ClientsLike, url));
});
