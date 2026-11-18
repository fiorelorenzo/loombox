/**
 * The one non-glue decision `push-native.ts`'s Capacitor-specific wiring
 * needs: given a raw native push event's `data` and this device's current
 * mute/quiet-hours state, whether to show anything and, if so, what. Pure
 * and Capacitor-API-free on purpose (same "logic in a plain module, glue in
 * the thin wrapper" split `apps/web` uses throughout) — composed entirely
 * from `@loombox/push-core`, the same functions `apps/web/src/service-worker.ts`'s
 * `push` listener calls.
 */
import {
  notificationContentFor,
  parsePushPayload,
  shouldSuppressPush,
  type NotificationContent,
  type NotificationPreferences,
  type SessionProjectMap,
} from '@loombox/push-core';

export type { NotificationContent, NotificationPreferences, SessionProjectMap };

/**
 * `apps/web/src/service-worker.ts`'s `push` listener body
 * (`parsePushPayload` -> `shouldSuppressPush` -> `notificationContentFor`),
 * as one pure function `push-native.ts`'s `pushNotificationReceived` glue
 * calls. Returns `undefined` both for a payload that fails to parse (an
 * unrecognized/malformed push, `parsePushPayload`) and for one that parses
 * but should be suppressed (`shouldSuppressPush`) — the caller doesn't need
 * to tell those two "show nothing" cases apart.
 */
export function decideNativePushNotification(
  rawData: unknown,
  preferences: NotificationPreferences,
  sessionProjectMap: SessionProjectMap,
  now?: Date,
): NotificationContent | undefined {
  const payload = parsePushPayload(rawData);
  if (!payload) return undefined;
  if (shouldSuppressPush(payload.sessionId, preferences, sessionProjectMap, now)) return undefined;
  return notificationContentFor(payload);
}
