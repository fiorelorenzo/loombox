/**
 * Native push registration + payload handling for the Capacitor shell
 * (#282), built on the #281 spike's `apps/mobile` scaffold.
 *
 * ## What's shared vs. what's genuinely platform-specific
 *
 * The actual decision logic — what a push payload means
 * (`parsePushPayload`), whether it should be suppressed
 * (`shouldSuppressPush`, per-project mute / quiet hours), what a user is
 * shown (`notificationContentFor`), and where a tap routes
 * (`sessionUrlFromNotificationData`, `resolvePendingPushAction`) — is
 * `@loombox/push-core`, extracted by this same issue from `apps/web`'s
 * `push-payload.ts`/`push-suppression.ts`/`push-action-routing.ts`. This
 * file is the Capacitor-specific *glue* around that shared logic, mirroring
 * `apps/web/src/service-worker.ts`'s own thin-glue role, adapted for two
 * real platform differences:
 *
 * 1. **Registration.** Web Push registers via `PushManager.subscribe()`
 *    against a self-owned VAPID keypair (`apps/web/src/lib/push-notifications.ts`).
 *    Native push has no VAPID equivalent — registration instead means
 *    asking the OS to hand back an APNs/FCM device token via Capacitor's
 *    `PushNotifications` plugin ({@link registerNativePush}).
 * 2. **Display.** The web path's Service Worker runs in its own JS context
 *    and calls `ServiceWorkerRegistration.showNotification()`. Capacitor's
 *    `PushNotifications` listeners run in the *same* WebView JS context as
 *    the rest of the app (whenever the app process is alive) — there is no
 *    separate worker, so no `postMessage` sync bridge is needed the way
 *    `service-worker.ts` needs one; a caller can pass live preferences
 *    straight into {@link decideNativePushNotification}. Capacitor has no
 *    single "show this notification" call shaped like `showNotification`,
 *    so display goes through `@capacitor/local-notifications`'
 *    `schedule()` instead ({@link localNotificationSchemaFor}).
 *
 * ## Why the relay must only ever send `{ kind, sessionId }` here too
 *
 * loombox is end-to-end encrypted; the relay is a blind router (SPEC §8)
 * and a push provider is a third party one step further removed than the
 * relay. `@loombox/push-core`'s `notificationContentFor` is the encryption
 * boundary: it derives the shown title/body from fixed strings plus the
 * already-cleartext `sessionId`, never from anything else a payload might
 * carry. That is exactly as true for FCM/APNs as it is for a browser's own
 * push service — the same shared function is what keeps the native path
 * from becoming a second place that boundary has to be re-implemented (and
 * could be re-implemented wrong). See `push-native.test.ts`'s "encryption
 * boundary" test and `@loombox/push-core`'s own `payload.test.ts`.
 *
 * Push messages are sent **data-only** (no FCM/APNs "notification" block)
 * for the same reason the web path controls display itself rather than
 * letting the OS auto-render a push-supplied title/body: suppression
 * (mute/quiet-hours) has to run *before* anything is shown, which is only
 * possible if the app's own code decides whether and what to display.
 * {@link startNativePushListening} is that decision point on native, the
 * same role `service-worker.ts`'s `push` listener plays on web.
 *
 * ## What this box cannot verify (no Android emulator, no iOS toolchain)
 *
 * Every function below is a plain, injectable-dependency module — the real
 * `@capacitor/push-notifications`/`@capacitor/local-notifications` plugin
 * objects are default parameters, never called directly — so registration
 * and payload-handling *decisions* are fully unit-tested here without a
 * real device. What is **not** verified by this PR, and needs a real
 * device/simulator run to verify:
 * - That the real APNs/FCM registration flow actually yields a token in
 *   the real Capacitor runtime (only the decision logic around whatever
 *   token/error arrives is tested).
 * - That a data-only push is actually delivered to `pushNotificationReceived`
 *   while the app is foregrounded/backgrounded-but-alive on a real device.
 * - Background/killed-app delivery. Android: FCM only calls into the app's
 *   JS runtime for a data-only message while the process is alive — a
 *   killed app requires a custom native `FirebaseMessagingService`, real
 *   native (Kotlin) code this Capacitor setup does not have and this box
 *   cannot build/run (`apps/mobile/android/` is generated, gitignored, and
 *   untested here — see `.gitignore`'s own comment). iOS: a silent/data-only
 *   remote notification needs a Notification Service Extension to become
 *   visible in the killed/background state — native (Swift) code with the
 *   same constraint. Both fail *closed* today (nothing shown, nothing
 *   leaked) rather than crashing or displaying something wrong — the
 *   safer of the two failure modes — but neither delivers. Extending
 *   coverage to the killed-app case is real follow-up work, not something
 *   this PR claims.
 * - Relay-side dispatch to a native subscription. This PR does not add an
 *   FCM/APNs sender or a relay endpoint to store native device tokens —
 *   doing that for real needs actual Firebase/Apple credentials this
 *   environment has none of, and shipping an uncredentialed, unverifiable
 *   sender would just be a stub. `registerNativePush` hands back the
 *   acquired token; wiring it to the relay is explicitly out of scope
 *   here (see this PR's description).
 */
import { Capacitor, type PermissionState } from '@capacitor/core';
import { LocalNotifications, type LocalNotificationSchema } from '@capacitor/local-notifications';
import { PushNotifications, type PushNotificationSchema } from '@capacitor/push-notifications';
import { PERMISSION_PUSH_ACTIONS, sessionUrlFromNotificationData } from '@loombox/push-core';

import {
  decideNativePushNotification,
  type NotificationContent,
  type NotificationPreferences,
  type SessionProjectMap,
} from './push-native-decision';

export type NativePushPlatform = 'ios' | 'android';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** The minimal surface {@link registerNativePush} needs off `@capacitor/push-notifications` — real methods, never the overloaded `addListener` directly (a hand-rolled, single-purpose `onRegistered`/`onRegistrationError` pair instead), so a test fake can be a plain object with no overload-signature gymnastics. */
export interface NativePushRegistrationDeps {
  requestPermissions(): Promise<{ receive: PermissionState }>;
  register(): Promise<void>;
  onRegistered(listener: (token: string) => void): void;
  onRegistrationError(listener: (message: string) => void): void;
}

function defaultNativePushRegistrationDeps(): NativePushRegistrationDeps {
  return {
    requestPermissions: () => PushNotifications.requestPermissions(),
    register: () => PushNotifications.register(),
    onRegistered(listener) {
      void PushNotifications.addListener('registration', (token) => listener(token.value));
    },
    onRegistrationError(listener) {
      void PushNotifications.addListener('registrationError', (error) => listener(error.error));
    },
  };
}

export type NativePushRegistrationResult =
  /** Not a native platform — the web preview / a dev build with no Capacitor runtime. The documented graceful fallback (issue #282's "falls back cleanly ... rather than crashing"), never thrown. */
  | { status: 'unavailable' }
  | { status: 'permission-denied' }
  | { status: 'registered'; platform: NativePushPlatform; token: string }
  | { status: 'registration-error'; message: string };

export interface RegisterNativePushOptions {
  isNativePlatform?: () => boolean;
  platform?: () => NativePushPlatform;
  deps?: NativePushRegistrationDeps;
}

/**
 * The full native registration flow (#282's "the Capacitor app registers
 * for platform push"): checks this is a real native runtime, requests
 * notification permission (the same OS permission — `UNUserNotificationCenter`
 * on iOS, `POST_NOTIFICATIONS` on Android 13+ — that governs displaying the
 * locally-scheduled notifications {@link startNativePushListening} shows,
 * so no separate `LocalNotifications.requestPermissions()` call is needed),
 * then registers and waits for whichever of Capacitor's `'registration'`/
 * `'registrationError'` events fires. Mirrors `push-notifications.ts`'s
 * `subscribeToPush` in shape: never throws on an unsupported/denied
 * platform, every result is an ordinary state a caller renders.
 */
export async function registerNativePush(
  options: RegisterNativePushOptions = {},
): Promise<NativePushRegistrationResult> {
  const isNativePlatform = options.isNativePlatform ?? (() => Capacitor.isNativePlatform());
  if (!isNativePlatform()) return { status: 'unavailable' };

  const platform = options.platform ?? (() => Capacitor.getPlatform() as NativePushPlatform);
  const deps = options.deps ?? defaultNativePushRegistrationDeps();

  const permission = await deps.requestPermissions();
  if (permission.receive !== 'granted') return { status: 'permission-denied' };

  const { promise, resolve } = Promise.withResolvers<NativePushRegistrationResult>();
  let settled = false;
  deps.onRegistered((token) => {
    if (settled) return;
    settled = true;
    resolve({ status: 'registered', platform: platform(), token });
  });
  deps.onRegistrationError((message) => {
    if (settled) return;
    settled = true;
    resolve({ status: 'registration-error', message });
  });
  await deps.register();
  return promise;
}

// ---------------------------------------------------------------------------
// Display: Capacitor Local Notifications adapter for @loombox/push-core's
// NotificationContent (built for the DOM Notification shape).
// ---------------------------------------------------------------------------

export const PERMISSION_ACTION_TYPE_ID = 'loombox-permission-request';

/** The minimal surface {@link registerPermissionActionType}/{@link startNativePushListening} need off `@capacitor/local-notifications`. */
export interface NativePushDisplayDeps {
  registerActionTypes(options: {
    types: { id: string; actions?: { id: string; title: string }[] }[];
  }): Promise<void>;
  onNotificationReceived(listener: (notification: PushNotificationSchema) => void): void;
  scheduleLocalNotification(schema: LocalNotificationSchema): Promise<void>;
  onActionPerformed(listener: (event: NativePushActionEvent) => void): void;
}

function defaultNativePushDisplayDeps(): NativePushDisplayDeps {
  return {
    registerActionTypes: (options) => LocalNotifications.registerActionTypes(options),
    onNotificationReceived(listener) {
      void PushNotifications.addListener('pushNotificationReceived', listener);
    },
    async scheduleLocalNotification(schema) {
      await LocalNotifications.schedule({ notifications: [schema] });
    },
    onActionPerformed(listener) {
      void LocalNotifications.addListener('localNotificationActionPerformed', (event) =>
        listener({ actionId: event.actionId, notification: { extra: event.notification.extra } }),
      );
    },
  };
}

/**
 * A stable 32-bit int id for `sessionId` — `LocalNotificationSchema.id`
 * must be a number (Android further requires it fit a signed 32-bit int).
 * Deterministic: scheduling a second `permission_required` push for an
 * already-notified session reuses the same id, so Capacitor/the OS
 * *replaces* the pending notification rather than stacking a duplicate —
 * the same "one live notification per session" behavior the web path gets
 * for free from `Notification.tag`. FNV-1a, chosen only for being small
 * and dependency-free — this is a display-grouping key, not a secret.
 */
export function notificationIdForSession(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index++) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/** Adapts `@loombox/push-core`'s DOM-`Notification`-shaped {@link NotificationContent} to Capacitor's `LocalNotificationSchema` — the one piece of real reshaping this platform needs, isolated to a single pure function. */
export function localNotificationSchemaFor(content: NotificationContent): LocalNotificationSchema {
  return {
    id: notificationIdForSession(content.options.data.sessionId),
    title: content.title,
    body: content.options.body ?? '',
    extra: content.options.data,
    actionTypeId: PERMISSION_ACTION_TYPE_ID,
  };
}

/** Registers the approve/deny/open action buttons (#165) as a Capacitor `ActionType`, from the exact same `PERMISSION_PUSH_ACTIONS` the web path's `Notification.actions[]` uses — Capacitor requires actions pre-registered by `actionTypeId` before a scheduled notification can reference them, unlike the web `Notification` constructor's per-call `actions`. Idempotent to call more than once (Capacitor overwrites a re-registered id). */
export async function registerPermissionActionType(
  deps: NativePushDisplayDeps = defaultNativePushDisplayDeps(),
): Promise<void> {
  await deps.registerActionTypes({
    types: [
      {
        id: PERMISSION_ACTION_TYPE_ID,
        actions: PERMISSION_PUSH_ACTIONS.map((descriptor) => ({
          id: descriptor.action,
          title: descriptor.title,
        })),
      },
    ],
  });
}

/** A tap on a locally-scheduled notification's body or one of its action buttons — Capacitor's `LocalNotificationsPlugin.addListener('localNotificationActionPerformed', ...)` shape, narrowed to just the two fields {@link sessionUrlFromNativePushAction} needs. */
export interface NativePushActionEvent {
  actionId: string;
  notification: { extra?: unknown };
}

/** The native equivalent of `service-worker.ts`'s `notificationclick` handler: reuses the exact same `sessionUrlFromNotificationData` the web path uses, since Capacitor's `extra` field is where {@link localNotificationSchemaFor} put the payload's `{ sessionId }` and its `actionId` carries the same `approve`/`deny`/`open`/plain-tap vocabulary (a plain body tap arrives as Capacitor's own reserved `'tap'` id, which — like `'open'` — is simply not `approve`/`deny`, so `sessionUrlFromNotificationData` already treats it as "just navigate", no native-specific casing needed). */
export function sessionUrlFromNativePushAction(event: NativePushActionEvent): string {
  return sessionUrlFromNotificationData(event.notification.extra, event.actionId);
}

export interface StartNativePushListeningOptions {
  getPreferences(): NotificationPreferences;
  getSessionProjectMap(): SessionProjectMap;
  onSessionUrl(url: string): void;
  deps?: NativePushDisplayDeps;
  now?: () => Date;
}

/**
 * Wires up the whole receive side (#282's "payload handling"): registers
 * the permission action type, then listens for both an incoming data-only
 * push (decides + displays, {@link decideNativePushNotification}) and a tap
 * on whatever got displayed (routes via {@link sessionUrlFromNativePushAction}).
 * The single call site a real app bootstrap will make once `apps/mobile`
 * wraps the actual PWA — see this module's own doc comment for why that
 * wiring isn't in this PR yet (`www/` is still #281's diagnostics probe).
 */
export async function startNativePushListening(
  options: StartNativePushListeningOptions,
): Promise<void> {
  const deps = options.deps ?? defaultNativePushDisplayDeps();
  await registerPermissionActionType(deps);

  deps.onNotificationReceived((notification) => {
    const content = decideNativePushNotification(
      notification.data,
      options.getPreferences(),
      options.getSessionProjectMap(),
      options.now?.(),
    );
    if (!content) return;
    void deps.scheduleLocalNotification(localNotificationSchemaFor(content));
  });

  deps.onActionPerformed((event) => {
    options.onSessionUrl(sessionUrlFromNativePushAction(event));
  });
}
