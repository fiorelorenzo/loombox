import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Wire surface for `@loombox/node`'s per-project/per-session spend cap
 * (SPEC §7.16 "Spend caps: a per-project and per-session cost cap that
 * auto-pauses the session and raises it in the attention inbox"; issue
 * #251). Two independent scopes, resolved the same way issue #753's
 * remembered-config-per-agent/project-override already established: the
 * more specific one wins, i.e. a session's own cap beats its project's
 * cap when both are set (`@loombox/node`'s `NodeDaemon.effectiveSpendCapUsd`
 * is the one place that resolution happens). This file only carries the
 * two raw values across the wire — it deliberately does NOT also send a
 * derived "effective cap"/"winning scope" field, exactly like
 * `permission-policy.ts` never sends a derived "default approval mode":
 * two numbers is the whole fact, and a UI can derive which one is
 * currently winning itself (`sessionCapUsd ?? projectCapUsd`) without a
 * second, independently-driftable source of truth for the same question.
 *
 * Three message pairs, mirroring `permission-policy.ts`'s own "two
 * request/reply pairs plus one live notification" shape rather than
 * inventing a fourth wire convention:
 * - `spend_cap_get` / `spend_cap_result` — read both of a session's
 *   current caps. No envelope on the request (asking "which session's
 *   project/session" carries nothing to hide, same reasoning as
 *   `permissionPolicyGet`); the result IS a real dollar figure a project
 *   may not want a compromised relay to see, so it travels sealed, same
 *   as `permission_policy_result`.
 * - `spend_cap_set` — save (fully replace, `capUsd: null` clears it) one
 *   scope's cap. `scope: 'session'` writes `SessionManager`'s own
 *   `Session.spendCapUsd`; `scope: 'project'` writes the owning node's
 *   `SpendCapStore`, keyed by `bridge.session.projectPath` exactly like
 *   `PermissionPolicyStore`. Reuses the same `spend_cap_result` reply
 *   `_get` uses, so "save" and "read the current value" are one
 *   client-side code path — and, per issue #251's "raising the cap is
 *   one of the ways to resume" design decision, a `_set` that raises the
 *   now-effective cap back above a paused session's current spend
 *   auto-resumes it as a side effect of this one deliberate act (see
 *   `NodeDaemon.maybeAutoResumeAfterCapChange`).
 * - `session_spend_cap_resume` — node-to-... no, client-to-node: an
 *   explicit "confirm continue despite the cap" (issue #251's OTHER way
 *   to resume, the one that changes nothing about the cap itself).
 *   Envelope-less and reply-less, mirroring `run_cancel`'s own "cancelling
 *   carries no content" shape: resuming carries no content either, and
 *   the resulting `session_status` transition away from `'paused'` is
 *   the confirmation, exactly like a cancelled run's own `run_exit`
 *   confirms `run_cancel` rather than a bespoke ack message. A silent
 *   no-op if the session wasn't actually paused (mirrors `run_cancel`'s
 *   "already exited or unknown" no-op) — see
 *   `NodeDaemon.handleSessionSpendCapResume`.
 *
 * Addressed by `sessionId` throughout, same reasoning
 * `permission-policy.ts`'s own doc comment already gives for its
 * identical choice: this is only ever edited from a Config panel inside
 * an open session, which already has a `sessionId` at hand, and neither
 * cap needs to be read before any session on the project exists.
 */

/** A spend cap in USD — positive and finite; `null` clears a previously-saved cap rather than setting one. Never zero or negative: a $0 cap is not a real spend limit, and this file has no separate "disabled" flag to confuse with a genuinely tiny one. */
const spendCapAmountUsd = z.number().positive().finite();

/** The plaintext a `spend_cap_set` envelope decrypts to — one scope, one new value. */
export const spendCapSetPayloadV1 = z.object({
  scope: z.enum(['project', 'session']),
  capUsd: spendCapAmountUsd.nullable(),
});
export type SpendCapSetPayloadV1 = z.infer<typeof spendCapSetPayloadV1>;

/** The plaintext a `spend_cap_result` envelope decrypts to — both scopes' current saved value, `null` where none is set. */
export const spendCapResultPayloadV1 = z.object({
  projectCapUsd: spendCapAmountUsd.nullable(),
  sessionCapUsd: spendCapAmountUsd.nullable(),
});
export type SpendCapResultPayloadV1 = z.infer<typeof spendCapResultPayloadV1>;

/** Parses and validates a decrypted `spend_cap_set` payload, throwing on an invalid one. */
export function parseSpendCapSetPayloadV1(data: unknown): SpendCapSetPayloadV1 {
  return spendCapSetPayloadV1.parse(data);
}

/** Same as {@link parseSpendCapSetPayloadV1} but never throws; returns zod's result. */
export function safeParseSpendCapSetPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SpendCapSetPayloadV1> {
  return spendCapSetPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `spend_cap_result` payload, throwing on an invalid one. */
export function parseSpendCapResultPayloadV1(data: unknown): SpendCapResultPayloadV1 {
  return spendCapResultPayloadV1.parse(data);
}

/** Same as {@link parseSpendCapResultPayloadV1} but never throws; returns zod's result. */
export function safeParseSpendCapResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SpendCapResultPayloadV1> {
  return spendCapResultPayloadV1.safeParse(data);
}

/** A client asks the owning node for a session's current project and session spend caps. No envelope — see this file's doc comment. */
export const spendCapGet = z.object({
  type: z.literal('spend_cap_get'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type SpendCapGet = z.infer<typeof spendCapGet>;

/** A client asks the owning node to save (or, with `capUsd: null`, clear) one scope's spend cap. */
export const spendCapSet = z.object({
  type: z.literal('spend_cap_set'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type SpendCapSet = z.infer<typeof spendCapSet>;

/** The owning node's reply to `spend_cap_get`/`spend_cap_set` — the session's current project and session caps. Fanned out to a session's subscribed clients exactly like `permission_policy_result`. */
export const spendCapResult = z.object({
  type: z.literal('spend_cap_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type SpendCapResult = z.infer<typeof spendCapResult>;

/** A client explicitly confirms continuing a session that auto-paused on a spend cap, without changing the cap itself (issue #251's other deliberate way to resume, alongside raising the cap via `spend_cap_set`). No envelope, no reply — see this file's doc comment. */
export const sessionSpendCapResume = z.object({
  type: z.literal('session_spend_cap_resume'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
});
export type SessionSpendCapResume = z.infer<typeof sessionSpendCapResume>;
