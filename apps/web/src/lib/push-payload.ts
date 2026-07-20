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

export interface NotificationContent {
  title: string;
  options: NotificationOptions & { data: { sessionId: string } };
}

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
    },
  };
}

/** The minimal `ServiceWorkerRegistration` surface the push handler needs. */
export interface NotificationShower {
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
}

/** Shows the notification for a validated push payload — the `push` event listener's whole job (#164). */
export async function showAttentionNotification(
  registration: NotificationShower,
  payload: AttentionPushPayload,
): Promise<void> {
  const { title, options } = notificationContentFor(payload);
  await registration.showNotification(title, options);
}

/** Builds the in-app URL a notification click should land on — `+page.svelte` reads `?session=` on load and selects it once the session list arrives (issue #164's "opens directly to the relevant session"). */
export function sessionUrlFromNotificationData(data: unknown): string {
  const sessionId =
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>).sessionId === 'string'
      ? ((data as Record<string, unknown>).sessionId as string)
      : undefined;
  return sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/';
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
