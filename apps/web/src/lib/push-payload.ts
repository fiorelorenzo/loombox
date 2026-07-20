/**
 * The service worker's own push-event handling logic (#164), pulled out of
 * `service-worker.ts` into a plain, DOM/SW-API-free module so it is
 * unit-testable with ordinary vitest mocks instead of a real
 * `ServiceWorkerGlobalScope` (`self.registration.showNotification`,
 * `clients.matchAll`/`openWindow`, ...) — the same "logic in a plain
 * module, glue in the thin wrapper" split this package uses throughout
 * (`attachments.ts` vs `AttachmentBar.svelte`, `text-pacer.ts` vs the
 * transcript rendering it drives).
 *
 * The payload shape mirrors `packages/relay/src/push.ts`'s `PushPayload`
 * exactly (mirrored, not imported — the same deliberate E2E-boundary
 * mirroring `relay-client.ts`'s own doc comment describes for
 * `SessionPrivateMeta`/`PromptPayload`: the relay and this web app are on
 * opposite sides of the wire, not sharing a workspace package here).
 */

/** SPEC §7.13's four attention-worthy event classes; only `'permission_required'` is ever actually sent by the relay today — see `push.ts`'s `PushPayload` doc comment for why the other three aren't reachable yet. An unrecognized future `kind` is ignored, not thrown on (`parsePushPayload` returns `undefined`), so an older client degrades safely against a newer relay. */
export interface AttentionPushPayload {
  kind: 'permission_required';
  sessionId: string;
}

/** Validates a decoded push `data` payload — never throws; an invalid/unrecognized payload is simply not shown as a notification. */
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
 * One `Notification.actions[]` entry (#165). TS's lib.dom `NotificationOptions`
 * — the type shared by the plain `Notification` constructor and
 * `ServiceWorkerRegistration.showNotification()` — omits `actions` entirely
 * (it only ever applies to the latter, SW-only call), so this fills that
 * lib gap instead of casting it away at every call site. Mirrors the real
 * `NotificationAction` DOM type (`action`/`title`/optional `icon`).
 */
export interface NotificationActionDescriptor {
  action: string;
  title: string;
  icon?: string;
}

export type ServiceWorkerNotificationOptions = NotificationOptions & {
  actions?: NotificationActionDescriptor[];
};

export interface NotificationContent {
  title: string;
  options: ServiceWorkerNotificationOptions & { data: { sessionId: string } };
}

/**
 * The action buttons a `permission_required` push exposes (#165, SPEC §7.3
 * "Mobile approval cards ... actionable buttons (OS-actionable push where
 * allowed)"). Only ever rendered where the platform supports notification
 * actions (iOS 16.4+, most desktop/Android browsers) — everywhere else the
 * browser silently ignores `actions` and shows a plain notification, which
 * still opens the app on tap via the ordinary `notificationclick` path
 * (`service-worker.ts`), the documented graceful degradation.
 */
export const PERMISSION_PUSH_ACTIONS: NotificationActionDescriptor[] = [
  { action: 'approve', title: 'Approve' },
  { action: 'deny', title: 'Deny' },
  { action: 'open', title: 'Open' },
];

/**
 * Non-sensitive, generic copy only — the relay never sent us the session's
 * decrypted title (SPEC §8's blind-relay boundary; `push.ts`'s own doc
 * comment), so there is nothing more specific to show than "a session"
 * without decrypting locally, which a push event has no key material to do.
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

/** The minimal `ServiceWorkerRegistration` surface the push handler needs. */
export interface NotificationShower {
  showNotification(title: string, options?: ServiceWorkerNotificationOptions): Promise<void>;
}

/** Shows the notification for a validated push payload — the `push` event listener's whole job (#164). */
export async function showAttentionNotification(
  registration: NotificationShower,
  payload: AttentionPushPayload,
): Promise<void> {
  const { title, options } = notificationContentFor(payload);
  await registration.showNotification(title, options);
}

/**
 * Builds the in-app URL a notification click should land on — `+page.svelte`
 * reads `?session=` on load and selects it once the session list arrives
 * (issue #164's "opens directly to the relevant session"). `action` (#165)
 * carries which notification button was tapped (`event.action` off a real
 * `NotificationEvent`, or `undefined`/`''` for a plain click on the
 * notification body itself) so `+page.svelte` can also auto-resolve an
 * approve/deny tap once this session's live permission queue arrives
 * (`push-action-routing.ts`'s `resolvePendingPushAction`) — omitted from the
 * URL entirely for a plain click or the `'open'` action, both of which are
 * just "go to this session", nothing to resolve.
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
