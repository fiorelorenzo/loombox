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
import {
  defaultNotificationPreferences,
  type NotificationPreferences,
} from '$lib/notification-preferences';
import { shouldSuppressPush, type SessionProjectMap } from '$lib/push-suppression';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

// #166: this device's mute/quiet-hours preferences and its known
// `sessionId -> projectPath` map, kept in sync by `+page.svelte`'s
// `syncNotificationPreferencesToServiceWorker` via `postMessage` (there is
// no `localStorage` access from a service worker, and the push payload
// itself carries no `projectPath` — see `push-suppression.ts`'s doc
// comment). Lives only in this worker's own memory: a freshly (re)started
// worker that hasn't yet heard from an open tab falls back to the
// defaults — no mutes, no quiet hours, an empty project map — so a push
// arriving before the first sync is never silently swallowed
// (`shouldSuppressPush`'s documented fail-open behavior).
let cachedPreferences: NotificationPreferences = defaultNotificationPreferences();
let cachedSessionProjectMap: SessionProjectMap = {};

interface NotificationPreferencesSyncMessage {
  type: 'loombox:notification-prefs-sync';
  preferences: NotificationPreferences;
  sessionProjectMap: SessionProjectMap;
}

function isNotificationPreferencesSyncMessage(
  data: unknown,
): data is NotificationPreferencesSyncMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'loombox:notification-prefs-sync'
  );
}

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (!isNotificationPreferencesSyncMessage(event.data)) return;
  cachedPreferences = event.data.preferences;
  cachedSessionProjectMap = event.data.sessionProjectMap;
});

// #164/#166: the SW receives the push and shows a notification, unless this
// session's project is muted or the current time falls in the configured
// quiet-hours window (`shouldSuppressPush`). `event.data` is the Web Push
// payload the relay sent — the small, non-sensitive routing hint
// `push.ts`'s `PushPayload` doc comment describes, never decrypted session
// content (the relay never had any to send).
self.addEventListener('push', (event: PushEvent) => {
  const payload = parsePushPayload(event.data?.json());
  if (!payload) return;
  if (shouldSuppressPush(payload.sessionId, cachedPreferences, cachedSessionProjectMap)) return;
  event.waitUntil(showAttentionNotification(self.registration, payload));
});

// #164/#165: clicking the notification body, or tapping one of its
// approve/deny/open action buttons, opens/focuses the app at the relevant
// session (`+page.svelte` reads `?session=` on load and selects it once the
// session list arrives). `event.action` is `''` for a plain body click (no
// action button involved) — `sessionUrlFromNotificationData` only appends
// `&action=` for a real `approve`/`deny` tap.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url = sessionUrlFromNotificationData(event.notification.data as unknown, event.action);
  // `Clients.matchAll` is typed by lib.dom as returning the base `Client[]`
  // regardless of the `{ type: 'window' }` filter passed in, even though at
  // runtime it is really `WindowClient[]` (the ones with `focus`/`navigate`)
  // — this cast bridges that known lib.dom typing gap, isolated to this one
  // call site.
  event.waitUntil(focusOrOpenSession(self.clients as unknown as ClientsLike, url));
});
