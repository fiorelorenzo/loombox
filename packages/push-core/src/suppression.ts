/**
 * Whether a `permission_required` push should actually show as a
 * notification (#166, SPEC §7.11 "Per-project mute and quiet-hours let the
 * user tune what interrupts them"). Extracted from `apps/web`'s
 * `push-suppression.ts` by #282 — a plain, platform-API-free module the web
 * service worker and `apps/mobile`'s native push handler both call as thin
 * glue around.
 *
 * The push payload itself only ever carries a `sessionId` (`payload.ts`'s
 * `AttentionPushPayload` doc comment: SPEC §8's blind-relay boundary), never
 * a `projectPath` — so per-project mute can only be enforced client-side by
 * looking the session's project up in a map the *app* already knows
 * (`ClientSessionMeta.projectPath`, `relay-client.ts`) and syncing it into
 * whichever context is deciding: the web service worker via `postMessage`
 * (`+page.svelte`'s `syncNotificationPreferencesToServiceWorker` — a
 * separate JS context has no other way in), or `apps/mobile`'s native push
 * handler directly, since it runs in the same WebView JS context as the
 * rest of the app rather than an isolated worker (`push-native.ts`'s own
 * doc comment). An unknown `sessionId` (this context never received a sync
 * yet, or this session hasn't loaded on this device before) fails open —
 * never suppressed — since a false negative here (a push slipping through
 * a mute) is far less harmful than a false positive (silently swallowing a
 * real approval request).
 */
import { isProjectMuted, isWithinQuietHours, type NotificationPreferences } from './preferences';

/** `sessionId -> projectPath`, kept in sync with the app's own session list. */
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
