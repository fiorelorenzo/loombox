/**
 * The relay-blind push payload's shape and the notification content derived
 * from it (#164/#165), extracted from `apps/web`'s `push-payload.ts` by
 * #282 so the Capacitor native push path (`apps/mobile/src/push-native.ts`)
 * can reuse the exact same decision logic instead of re-deriving it. Pure
 * and platform-API-free — every browser/service-worker/Capacitor-specific
 * call (`ServiceWorkerRegistration.showNotification`, Capacitor's
 * `LocalNotifications.schedule`, ...) lives in each platform's own thin
 * glue module (`apps/web/src/lib/push-payload.ts`,
 * `apps/mobile/src/push-native.ts`), never here.
 *
 * The payload shape mirrors `packages/relay/src/push.ts`'s `PushPayload`
 * exactly (mirrored, not imported — that file's own doc comment: the relay
 * and every client are on opposite sides of the wire, not sharing a
 * workspace package across that boundary). `apps/web` and `apps/mobile`
 * are on the *same* side of that boundary — both are "the client" the
 * relay is blind to the content of — so sharing this module between them
 * is the opposite move on purpose, not an inconsistency with that rule.
 */

/** SPEC §7.13's four attention-worthy event classes; only `'permission_required'` is ever actually sent by the relay today — see `packages/relay/src/push.ts`'s `PushPayload` doc comment for why the other three aren't reachable yet. An unrecognized future `kind` is ignored, not thrown on (`parsePushPayload` returns `undefined`), so an older client degrades safely against a newer relay. */
export interface AttentionPushPayload {
  kind: 'permission_required';
  sessionId: string;
}

/**
 * Validates a decoded push `data` payload — never throws; an
 * invalid/unrecognized payload is simply not shown as a notification.
 * Deliberately permissive of *extra* fields on `data` (never rejects an
 * object just for carrying more than `kind`/`sessionId`): `notificationContentFor`
 * below is what actually decides what a user sees, and it never reads
 * anything but the two fields this function itself extracts — see its own
 * doc comment for why that is the real encryption-boundary guarantee, not
 * a stricter shape check here.
 */
export function parsePushPayload(data: unknown): AttentionPushPayload | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const candidate = data as Record<string, unknown>;
  if (
    candidate.kind === 'permission_required' &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0
  ) {
    return { kind: 'permission_required', sessionId: candidate.sessionId };
  }
  return undefined;
}

/**
 * One notification action button (#165). Named for the DOM
 * `NotificationAction` shape (`action`/`title`/optional `icon`) it mirrors,
 * which both the web `Notification.actions[]` and (via a small field-name
 * adapter, `apps/mobile/src/push-native.ts`'s `toCapacitorAction`)
 * Capacitor's `Action` shape (`id`/`title`) consume.
 */
export interface NotificationActionDescriptor {
  action: string;
  title: string;
  icon?: string;
}

/**
 * TS's lib.dom `NotificationOptions` — the type shared by the plain
 * `Notification` constructor and `ServiceWorkerRegistration.showNotification()`
 * — omits `actions` entirely (it only ever applies to the latter, SW-only
 * call), so this fills that lib gap instead of casting it away at every
 * call site. Named platform-neutrally (not "ServiceWorker...") because
 * #282 made it Capacitor's own adapter's input shape too, not just the
 * service worker's.
 */
export type PushNotificationOptions = NotificationOptions & {
  actions?: NotificationActionDescriptor[];
};

export interface NotificationContent {
  title: string;
  options: PushNotificationOptions & { data: { sessionId: string } };
}

/**
 * The action buttons a `permission_required` push exposes (#165, SPEC §7.3
 * "Mobile approval cards ... actionable buttons (OS-actionable push where
 * allowed)"). Web: only ever rendered where the platform supports
 * `Notification.actions` (iOS 16.4+ Safari, most desktop/Android browsers)
 * — everywhere else the browser silently ignores `actions` and shows a
 * plain notification, which still opens the app on tap via the ordinary
 * click path. Native (#282): Capacitor's Local Notifications require these
 * pre-registered as an `ActionType` before a scheduled notification can
 * reference them by `actionTypeId` (`apps/mobile/src/push-native.ts`'s
 * `registerPermissionActionType`).
 */
export const PERMISSION_PUSH_ACTIONS: NotificationActionDescriptor[] = [
  { action: 'approve', title: 'Approve' },
  { action: 'deny', title: 'Deny' },
  { action: 'open', title: 'Open' },
];

/**
 * Non-sensitive, generic copy only — the relay never sent us the session's
 * decrypted title (SPEC §8's blind-relay boundary; `packages/relay/src/push.ts`'s
 * own doc comment), so there is nothing more specific to show than "a
 * session" without decrypting locally, which a push event has no key
 * material to do.
 *
 * This function *is* the encryption boundary in code: every field it
 * returns is either a fixed string or the already-cleartext `sessionId`
 * that any push provider (a browser vendor's push service for Web Push,
 * FCM/APNs for #282's native path) necessarily already saw in order to
 * route the message at all — never anything derived from `payload`'s other
 * fields, even if a malformed or compromised payload carried more than
 * `kind`/`sessionId` (`parsePushPayload` is deliberately permissive of
 * extra fields; this function is what makes that safe by never reading
 * them). `payload.test.ts`'s "never leaks any decrypted content" test
 * pins this down against an adversarial payload.
 */
export function notificationContentFor(payload: AttentionPushPayload): NotificationContent {
  return {
    title: 'Approval needed',
    options: {
      body: 'A session is waiting for you to approve a tool call.',
      tag: `loombox-session-${payload.sessionId}`,
      data: { sessionId: payload.sessionId },
      actions: PERMISSION_PUSH_ACTIONS,
    },
  };
}

/**
 * Builds the in-app URL a notification click should land on — `+page.svelte`
 * reads `?session=` on load and selects it once the session list arrives
 * (issue #164's "opens directly to the relevant session"). `action` (#165)
 * carries which notification button was tapped (a real `NotificationEvent.action`
 * on web, an `ActionPerformed.actionId` on native, `push-native.ts`) so
 * `+page.svelte` can also auto-resolve an approve/deny tap once this
 * session's live permission queue arrives (`action-routing.ts`'s
 * `resolvePendingPushAction`) — omitted from the URL entirely for a plain
 * click or the `'open'` action, both of which are just "go to this
 * session", nothing to resolve.
 */
export function sessionUrlFromNotificationData(data: unknown, action?: string): string {
  const sessionId =
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>).sessionId === 'string'
      ? ((data as Record<string, unknown>).sessionId as string)
      : undefined;
  if (!sessionId) return '/';
  const base = `/?session=${encodeURIComponent(sessionId)}`;
  return action === 'approve' || action === 'deny' ? `${base}&action=${action}` : base;
}
