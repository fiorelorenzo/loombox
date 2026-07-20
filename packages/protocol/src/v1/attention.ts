import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/**
 * A relay-visible, metadata-only hint that an attention-inbox-eligible
 * session-status transition just happened (SPEC §7.11/§7.13; issue #170).
 * Mirrors how `permission_request` (`steering.ts`) already gives the relay a
 * cleartext `sessionId` to route/push on without ever decrypting session
 * content (see `packages/relay/src/push.ts`'s `PushPayload` doc comment):
 * the node sends this ALONGSIDE — never instead of — the real
 * `session_status` lifecycle event it already seals into the encrypted
 * `session_update` envelope (`session-events.ts`'s `sessionStatusEventV1`).
 * This message carries only `class` + `sessionId`, never the encrypted
 * event's own detail (no `stopReason`, no tool-call/message content) — just
 * enough for the relay to decide whether to fire a Web Push, never anything
 * a subscribed client hasn't already been sent, encrypted, over
 * `session_update`.
 *
 * `class` mirrors two of `apps/web`'s `AttentionInboxItem.kind` values
 * (`relay-client.ts`) — `'awaiting_input'` and `'session_outcome'` (the
 * latter covers both the `exited`/finished and `error`/errored session
 * statuses; SPEC §7.13 groups them as one inbox class, and this hint does
 * the same rather than leaking which one, since that distinction is only
 * needed for the encrypted transcript, not for deciding whether to push).
 * These are the two of SPEC §7.13's four inbox classes that, as of v1, have
 * a live session-status source at all:
 * - `'permission'` already has its own top-level `permission_request`
 *   message (`steering.ts`) and needs no separate hint here.
 * - `'ci_failure'`/`'review_request'` have no live source yet (SPEC §7.14,
 *   v2 git/CI/tracker integration) — nothing to mirror for them until then.
 */
export const attentionHintClass = z.enum(['awaiting_input', 'session_outcome']);
export type AttentionHintClass = z.infer<typeof attentionHintClass>;

/** See {@link attentionHintClass}'s doc comment for the full rationale. */
export const attentionHint = z.object({
  type: z.literal('attention_hint'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  class: attentionHintClass,
});
export type AttentionHint = z.infer<typeof attentionHint>;
