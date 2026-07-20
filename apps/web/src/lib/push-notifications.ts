/**
 * Web Push subscription registration — the client half of self-owned VAPID
 * push (SPEC §7.11/§16; issues #162/#163). Every browser API this module
 * touches is an injectable parameter with a real-browser default (the same
 * pattern `auth-store.ts`/`amk-store.ts`/`copy.ts` already use throughout
 * this package), so the whole subscribe flow is unit-testable in the
 * `node` vitest environment without a real Service Worker, `PushManager`,
 * or `Notification` global. `+page.svelte`/`PushNotificationToggle.svelte`
 * call this only from a user-triggered action (a button click) — never
 * unconditionally on load (SPEC §7.11's "an appropriate, non-intrusive
 * point").
 */

/** Mirrors the four states a browser's own `Notification.permission` plus feature-detection collapse to — what the subscribe UI actually renders. */
export type PushSupportState = 'unsupported' | 'default' | 'denied' | 'granted';

/**
 * Feature-detects Push/Notification support and reads the current
 * permission — never throws even where `Notification`/`PushManager` don't
 * exist (SSR, an unsupported browser, or this package's own hermetic
 * `node`-environment tests): `in` on a real `window`/`navigator` object is
 * always safe, it just reports `false` for a missing global.
 */
export function pushSupportState(win: typeof globalThis = globalThis): PushSupportState {
  const hasWindow = typeof win !== 'undefined';
  const nav = hasWindow ? (win as unknown as { navigator?: Navigator }).navigator : undefined;
  const supported =
    hasWindow && !!nav && 'serviceWorker' in nav && 'PushManager' in win && 'Notification' in win;
  if (!supported) return 'unsupported';
  const Notif = (win as unknown as { Notification: { permission: NotificationPermission } })
    .Notification;
  return Notif.permission;
}

/**
 * `PushSubscription.toJSON()`'s shape — what both `PushManager.subscribe()`
 * resolves to (via `.toJSON()`) and what the relay's `POST /push/subscribe`
 * body expects (`relay.ts`'s `isPushSubscribeBody`), so no reshaping happens
 * at the boundary.
 */
export interface PushSubscriptionJson {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

/** The minimal `ServiceWorkerRegistration` surface this module needs — satisfied by the real one and by a test fake. */
export interface PushCapableRegistration {
  pushManager: {
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: BufferSource }): Promise<{
      toJSON(): PushSubscriptionJson;
    }>;
  };
}

/**
 * A VAPID public key (URL-safe base64, RFC 8292) -> the raw
 * `Uint8Array` `PushManager.subscribe()`'s `applicationServerKey` expects
 * (a browser API quirk: it wants raw bytes, not the base64 string the relay
 * hands out over `/push/vapid-public-key`). Grounded in the standard MDN
 * `urlBase64ToUint8Array` recipe used by every Web Push tutorial.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export type SubscribeResult =
  | { status: 'subscribed' }
  | { status: 'unsupported' }
  | { status: 'permission-denied' }
  | { status: 'push-disabled-on-relay' };

export interface SubscribeToPushOptions {
  /** The relay's HTTP(S) origin (same one `AuthStore`/`RelayClient` already point at). */
  relayBaseUrl: string;
  /** This device's Better Auth bearer token — the same one the WS handshake's `authToken` uses. */
  authToken: string;
  /** This device's stable id (`device-id-store.ts`) — must match the id the live `RelayClient` WS connection registers under, or the relay's presence check (#163) can never see this device as "currently connected". */
  deviceId: string;
  /** Injectable for tests; defaults to the real browser flow. */
  requestPermission?: () => Promise<NotificationPermission>;
  getRegistration?: () => Promise<PushCapableRegistration>;
  fetchImpl?: typeof fetch;
  win?: typeof globalThis;
}

async function defaultRequestPermission(): Promise<NotificationPermission> {
  return Notification.requestPermission();
}

async function defaultGetRegistration(): Promise<PushCapableRegistration> {
  return navigator.serviceWorker.ready;
}

/**
 * The full subscribe flow (#162): request permission, fetch the relay's
 * VAPID public key, subscribe via the service worker's `PushManager`, then
 * register the resulting subscription with the relay
 * (`POST /push/subscribe`, #161). Never throws on an unsupported browser or
 * a denied/dismissed permission prompt — both are ordinary result states a
 * caller renders, not exceptional (SPEC §7.11's "handle unsupported/denied
 * gracefully").
 */
export async function subscribeToPush(options: SubscribeToPushOptions): Promise<SubscribeResult> {
  const win = options.win ?? globalThis;
  if (pushSupportState(win) === 'unsupported') return { status: 'unsupported' };

  const requestPermission = options.requestPermission ?? defaultRequestPermission;
  const permission = await requestPermission();
  if (permission !== 'granted') return { status: 'permission-denied' };

  const fetchImpl = options.fetchImpl ?? fetch;
  const keyResponse = await fetchImpl(`${options.relayBaseUrl}/push/vapid-public-key`);
  if (keyResponse.status === 404) return { status: 'push-disabled-on-relay' };
  if (!keyResponse.ok) {
    throw new Error(`subscribeToPush: failed to fetch VAPID public key (${keyResponse.status})`);
  }
  const { publicKey } = (await keyResponse.json()) as { publicKey: string };

  const getRegistration = options.getRegistration ?? defaultGetRegistration;
  const registration = await getRegistration();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    // `BufferSource` (not `Uint8Array<ArrayBuffer>`): the DOM lib's
    // `PushSubscriptionOptionsInit.applicationServerKey` and TS's own
    // `Uint8Array` constructor return type disagree on the buffer's exact
    // generic parameter across recent TS/lib versions; a plain, freshly
    // allocated `Uint8Array` is always a real `ArrayBufferView` at runtime
    // regardless of that type-level mismatch.
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error('subscribeToPush: browser subscription is missing endpoint/p256dh/auth');
  }

  const subscribeResponse = await fetchImpl(`${options.relayBaseUrl}/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${options.authToken}` },
    body: JSON.stringify({
      deviceId: options.deviceId,
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    }),
  });
  if (!subscribeResponse.ok) {
    throw new Error(
      `subscribeToPush: relay rejected the subscription (${subscribeResponse.status})`,
    );
  }

  return { status: 'subscribed' };
}
