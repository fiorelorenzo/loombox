/**
 * Routes a Web Push notification action (#165) back to a real permission
 * resolution. `push-payload.ts` gives the pushed notification its
 * `approve`/`deny`/`open` action buttons; this module is the other half —
 * "the SW notificationclick handler routes each action ... via the existing
 * resolve-permission path when the client wakes" (this wave's brief) — a
 * plain, DOM/SW-API-free module so it is unit-testable the same way
 * `push-payload.ts` itself is, no real `ServiceWorkerGlobalScope`,
 * `RelayClient`, or Svelte component required.
 *
 * The push payload only ever carries a `sessionId` (SPEC §8's blind-relay
 * boundary: the relay never sent a `requestId` or `options[]`, only a
 * routing hint), so there is nothing to resolve inside the service worker
 * itself. Instead, tapping "Approve"/"Deny" opens/focuses the app at
 * `/?session=<id>&action=approve|deny` (`sessionUrlFromNotificationData` in
 * `push-payload.ts`); once the app "wakes" and that session's real
 * `PermissionQueueState` arrives over the live WS connection, `+page.svelte`
 * calls {@link resolvePendingPushAction} to turn that URL's action into the
 * actual `{ requestId, option }` pair `RelayClient.resolvePermission`
 * expects — the exact same resolve path a manual tap on `PermissionCard`
 * uses, never a second, parallel one.
 */
import type { AcpPermissionOption, PermissionQueueState } from '@loombox/providers-core';
import { headPermissionRequest } from '@loombox/providers-core';

/** The two push-notification actions that resolve a permission request; `'open'` (and a plain, non-`action` click) just navigates — nothing to resolve. */
export type ResolvingPushAction = 'approve' | 'deny';

/** Narrows an arbitrary `?action=` query value (or a service worker `NotificationEvent.action`) to one this module knows how to resolve. */
export function parseResolvingPushAction(
  value: string | null | undefined,
): ResolvingPushAction | undefined {
  return value === 'approve' || value === 'deny' ? value : undefined;
}

/**
 * Picks which of the FIFO head's provider-given `options[]` an
 * approve/deny push action maps to. Every real provider tier (Claude,
 * Codex, the generic fallback) always offers a `'allow_once'`/`'reject_once'`
 * option (`AcpPermissionOptionKind`'s vocabulary; SPEC.md §7.24) — this
 * prefers the "once" tier over `'allow_always'`/`'reject_always'` so a
 * one-tap notification action never grants more than the single tool call
 * that woke it, then falls back to the "always" tier only if a provider's
 * option set somehow omits the "once" kind. Returns `undefined` if neither
 * kind is present (an option set this module doesn't recognize) — the
 * caller then simply doesn't resolve, leaving the request queued for the
 * user to act on manually.
 */
export function pickPermissionOptionForAction(
  options: readonly AcpPermissionOption[],
  action: ResolvingPushAction,
): AcpPermissionOption | undefined {
  const preferredKind = action === 'approve' ? 'allow_once' : 'reject_once';
  const fallbackKind = action === 'approve' ? 'allow_always' : 'reject_always';
  return (
    options.find((option) => option.kind === preferredKind) ??
    options.find((option) => option.kind === fallbackKind)
  );
}

export interface PendingPushActionResolution {
  requestId: string;
  option: AcpPermissionOption;
}

/**
 * The whole "client wakes up" resolve path (#165): given the session's
 * live permission queue and the action a push notification's URL carried,
 * resolves to the exact `{ requestId, option }` `RelayClient.resolvePermission`
 * needs, or `undefined` when there is nothing (yet) to resolve — no pending
 * request for this session (already resolved elsewhere, or the push arrived
 * before the request did), or an action that isn't `approve`/`deny`
 * (`'open'`, or no action at all). Only ever resolves the FIFO head, exactly
 * like a manual tap on `PermissionCard` — a queued, non-head request is
 * never skipped ahead of.
 */
export function resolvePendingPushAction(
  queue: PermissionQueueState,
  sessionId: string,
  action: string | null | undefined,
): PendingPushActionResolution | undefined {
  const resolvingAction = parseResolvingPushAction(action);
  if (!resolvingAction) return undefined;

  const head = headPermissionRequest(queue, sessionId);
  if (!head) return undefined;

  const option = pickPermissionOptionForAction(head.options, resolvingAction);
  if (!option) return undefined;

  return { requestId: head.requestId, option };
}
