/**
 * Whether a `permission_required` push should actually show as a
 * notification (#166, SPEC §7.11 "Per-project mute and quiet-hours let the
 * user tune what interrupts them"). A plain, DOM/SW-API-free module, same
 * split as `push-payload.ts`: the decision is pure and unit-tested here, the
 * service worker's `push` listener is thin glue that calls it.
 *
 * The push payload itself only ever carries a `sessionId` (`push-payload.ts`'s
 * `AttentionPushPayload` doc comment: SPEC §8's blind-relay boundary), never
 * a `projectPath` — so per-project mute can only be enforced client-side by
 * looking the session's project up in a map the *page* already knows
 * (`ClientSessionMeta.projectPath`, `relay-client.ts`) and hands to the
 * service worker via `postMessage` (`+page.svelte`'s
 * `syncNotificationPreferencesToServiceWorker`). An unknown `sessionId` (the
 * service worker never received a sync yet, or this session hasn't loaded
 * on this device before) fails open — never suppressed — since a false
 * negative here (a push slipping through a mute) is far less harmful than a
 * false positive (silently swallowing a real approval request).
 */
import {
  isProjectMuted,
  isWithinQuietHours,
  type NotificationPreferences,
} from './notification-preferences';

/** `sessionId -> projectPath`, kept in sync with the page's own session list. */
export type SessionProjectMap = Readonly<Record<string, string>>;

export function shouldSuppressPush(
  sessionId: string,
  prefs: NotificationPreferences,
  sessionProjectMap: SessionProjectMap,
  now: Date = new Date(),
): boolean {
  if (isWithinQuietHours(prefs, now)) return true;
  const projectPath = sessionProjectMap[sessionId];
  return projectPath !== undefined && isProjectMuted(prefs, projectPath);
}
