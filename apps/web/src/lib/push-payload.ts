/**
 * The service worker's own push-event display/click glue (#164), pulled out
 * of `service-worker.ts` — the same "logic in a plain module, glue in the
 * thin wrapper" split this package uses throughout (`attachments.ts` vs
 * `AttachmentBar.svelte`, `windowing.svelte.ts` vs `TranscriptTimeline.svelte`).
 *
 * #282 split this file: the actual payload/notification-content decision
 * logic (`parsePushPayload`, `notificationContentFor`, `PERMISSION_PUSH_ACTIONS`,
 * `sessionUrlFromNotificationData`) moved to `@loombox/push-core` so
 * `apps/mobile`'s native push path (Capacitor, no Service Worker) can reuse
 * it without duplicating it — see that package for the shape/encryption-
 * boundary doc comments. What's left here is genuinely
 * `ServiceWorkerRegistration`/`Clients`-shaped: showing a notification via
 * the SW's own `showNotification`, and focusing/opening a browser tab via
 * `Clients.matchAll`/`openWindow` — APIs a Capacitor WebView has no
 * equivalent of (there is only ever one window there; native tap-through is
 * a URL/router navigation instead, `apps/mobile/src/push-native.ts`).
 */
import {
  notificationContentFor,
  type AttentionPushPayload,
  type PushNotificationOptions,
} from '@loombox/push-core';

/** The minimal `ServiceWorkerRegistration` surface the push handler needs. */
export interface NotificationShower {
  showNotification(title: string, options?: PushNotificationOptions): Promise<void>;
}

/** Shows the notification for a validated push payload — the `push` event listener's whole job (#164). */
export async function showAttentionNotification(
  registration: NotificationShower,
  payload: AttentionPushPayload,
): Promise<void> {
  const { title, options } = notificationContentFor(payload);
  await registration.showNotification(title, options);
}

/** The minimal `WindowClient` surface `focusOrOpenSession` needs. */
export interface FocusableWindowClient {
  url: string;
  focus(): Promise<unknown>;
  /** Real `WindowClient.navigate` — optional here only so a minimal test fake need not implement it when a test doesn't care about the navigate path. */
  navigate?(url: string): Promise<unknown>;
}

/** The minimal `Clients` surface `focusOrOpenSession` needs. */
export interface ClientsLike {
  matchAll(options?: {
    type?: 'window';
    includeUncontrolled?: boolean;
  }): Promise<readonly FocusableWindowClient[]>;
  openWindow(url: string): Promise<unknown>;
}

/**
 * The `notificationclick` handler's whole job (#164's "tapping/clicking a
 * notification opens directly to the relevant session"): focus (and
 * navigate, if it supports it) an already-open app window, or open a fresh
 * one at the session's URL if none is open.
 */
export async function focusOrOpenSession(clientsApi: ClientsLike, url: string): Promise<void> {
  const openClients = await clientsApi.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = openClients[0];
  if (existing) {
    if (existing.navigate) await existing.navigate(url);
    await existing.focus();
    return;
  }
  await clientsApi.openWindow(url);
}
