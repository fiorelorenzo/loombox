import webpush, { WebPushError } from 'web-push';

import type { PushSubscriptionRecord, VapidKeyPair, VapidKeyStore } from './store';

/**
 * Self-owned Web Push (SPEC §7.11/§16 "self-owned VAPID push, no third-party
 * push relay"; issues #161/#163). The relay is a blind router (SPEC §8) —
 * this module never sends anything derived from decrypted session content,
 * only the small routing hints `relay.ts` itself already legitimately
 * observes as cleartext (a `permission_request`'s `sessionId`, never its
 * opaque `envelope`). See {@link PushPayload}.
 */

/**
 * The relay-originated, non-sensitive payload a Web Push notification
 * carries — "enough to route/wake, not decrypted content" (this issue's own
 * framing; issue #170 extended this from one to three classes). Each `kind`
 * is one of SPEC §7.11/§7.13's attention-inbox classes that has a
 * relay-visible, cleartext trigger as of v1:
 * - `'permission_required'` — a tool-call approval; `permission_request` is
 *   a top-level `WireMessageV1` the relay already routes without decrypting
 *   (`steering.ts`'s doc comment: "the request body is opaque, encrypted
 *   content" but the `sessionId`/message type are clear).
 * - `'awaiting_input'` / `'session_outcome'` — a session's live status
 *   settled to `awaiting_input`, or to `exited`/`error` (finished/errored).
 *   That status is itself a `session_status` event sealed *inside* the
 *   encrypted `session_update` envelope (`session-events.ts`'s doc comment:
 *   "the relay is never told about them"), so the node additionally sends a
 *   metadata-only `attention_hint` (`@loombox/protocol`'s `attention.ts`) —
 *   `class` + `sessionId`, never the encrypted event's own detail — purely
 *   so this relay-blind module has something cleartext to trigger on, the
 *   same mechanism `permission_request` already used.
 *
 * CI-failure and review-request events have no backing subsystem yet (§7.14
 * is v2 work) — extending this union to those needs either decrypting on the
 * relay (a hard no, SPEC §8) or a client-observed trigger, both future work.
 */
export interface PushPayload {
  kind: 'permission_required' | 'awaiting_input' | 'session_outcome';
  sessionId: string;
}

/** The three fields a `PushSender` needs off a stored subscription — a structural subset of `PushSubscriptionRecord` so a caller doesn't have to pick fields out by hand at every call site. */
export type PushTarget = Pick<PushSubscriptionRecord, 'endpoint' | 'p256dh' | 'auth'>;

export interface PushSendResult {
  /** True when the push service reported the subscription is gone (410 Gone / 404 Not Found) — the caller should delete it (`PushSubscriptionStore.delete`) rather than keep retrying it (#163's self-cleaning). */
  expired: boolean;
}

/** Injectable so `relay.ts`'s presence-aware delivery path (#163) is testable without a real Web Push network call — see `push.test.ts`'s fake sender. */
export interface PushSender {
  send(
    target: PushTarget,
    vapidKeys: VapidKeyPair,
    vapidSubject: string,
    payload: PushPayload,
  ): Promise<PushSendResult>;
}

/**
 * The real sender, wrapping the `web-push` npm package (SPEC §16 grounding:
 * hapi `pushService.ts`, RFC 8291/8292). `sendNotification` is an injectable
 * seam — always `webpush.sendNotification` in production — so
 * `push.test.ts` can exercise this function's real VAPID/payload-encryption
 * argument marshaling and its real 410/404-vs-other status handling (with a
 * genuine `WebPushError`) without needing a live push endpoint reachable
 * from this box, the same "swap only the actual network I/O" seam this
 * package already uses everywhere else (`PushSender` itself, `FanOutBackend`,
 * `PgLike`, ...).
 */
export function createWebPushSender(
  sendNotification: typeof webpush.sendNotification = webpush.sendNotification,
): PushSender {
  return {
    async send(target, vapidKeys, vapidSubject, payload) {
      try {
        await sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(payload),
          {
            vapidDetails: {
              subject: vapidSubject,
              publicKey: vapidKeys.publicKey,
              privateKey: vapidKeys.privateKey,
            },
          },
        );
        return { expired: false };
      } catch (error) {
        // A 410 Gone (spec'd) or 404 Not Found (some push services' actual
        // behavior for a since-unsubscribed endpoint) means the browser
        // itself dropped this subscription — never a transient failure to
        // retry. Any other status (network error, 5xx, a malformed
        // subscription) is rethrown: it is not this module's call whether
        // that is worth logging/alerting on, `relay.ts`'s caller decides.
        if (
          error instanceof WebPushError &&
          (error.statusCode === 410 || error.statusCode === 404)
        ) {
          return { expired: true };
        }
        throw error;
      }
    },
  };
}

export interface VapidKeysOptions {
  /** The VAPID JWT's `sub` claim — a `mailto:` address or an `https:` URL identifying the relay operator (RFC 8292). */
  subject: string;
  /** Set from `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` when the operator supplies its own keypair; takes priority over anything stored. */
  envKeys?: VapidKeyPair;
  /** Injectable for tests; defaults to `web-push`'s own `generateVAPIDKeys()`. */
  generate?: () => VapidKeyPair;
}

/**
 * Resolves the relay's self-owned VAPID keypair (#161's "generates and
 * persists a VAPID keypair on first setup"): an operator-supplied env
 * keypair wins outright (never persisted redundantly — the env is already
 * that operator's own persistence); otherwise a keypair already in `store`
 * wins; otherwise a fresh one is generated and persisted via
 * `store.vapidKeys.saveIfAbsent` — see that method's doc comment for why a
 * concurrent-boot race still converges on one shared keypair.
 */
export async function resolveVapidKeys(
  store: VapidKeyStore,
  opts: VapidKeysOptions,
): Promise<VapidKeyPair> {
  if (opts.envKeys) return opts.envKeys;
  const existing = await store.get();
  if (existing) return existing;
  const generated = (opts.generate ?? webpush.generateVAPIDKeys)();
  return store.saveIfAbsent(generated);
}
