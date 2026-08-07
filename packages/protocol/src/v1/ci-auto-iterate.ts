import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * The agent auto-iterate-until-green loop's own wire shape (SPEC §7.14/
 * §7.15; issue #246) — the sibling of `ci-check.ts`, picking up exactly
 * where that file's own doc comment says it stops: `NodeDaemon.
 * handleCiCheckFailure` (issue #239) fires once per new failing commit and
 * hands off to `packages/node/src/ci-auto-iterate.ts`'s `CiAutoIterateController`,
 * which decides whether THIS failure actually drives a new agent turn and
 * tracks the resulting loop's state. This file is what carries that state
 * back over the wire, and what a client uses to stop the loop early.
 *
 * `ci_auto_iterate_status`: one node-pushed message, no request, streaming
 * a session's current auto-iterate state to its subscribed clients —
 * pushed on every state change (a new attempt, a green stop, a max-
 * attempts stop, or a user stop), never on every CI poll (unlike
 * `ci_check_status`, which pushes unconditionally every pass). Session-
 * scoped and envelope-sealed for the same SPEC §8 reason every other
 * per-session payload is: `history` below can end up describing real
 * commits on a real branch, so the relay only ever sees `sessionId` and
 * ciphertext.
 *
 * `ci_auto_iterate_stop`: a client's own "stop this now" — envelope-less
 * and reply-less, mirroring `run_cancel`/`session_spend_cap_resume`'s
 * identical "carries no content beyond `sessionId`" shape (the resulting
 * `ci_auto_iterate_status` push, with `stoppedReason: 'user_stop'`, is the
 * confirmation, exactly like a cancelled run's own `run_exit` confirms
 * `run_cancel` rather than a bespoke ack message).
 */

/**
 * Why an active loop is no longer active — set only once the loop has
 * actually stopped iterating (`undefined` while `active: true`, or while a
 * session has never had a CI failure to react to at all):
 * - `'green'` — the check went from failing to `'passing'`; the loop's own
 *   job is done. Attempts reset to zero: a LATER new failure (a later
 *   commit, a flake) starts a clean loop rather than inheriting a stale
 *   count.
 * - `'max_attempts'` — `attempts` reached `maxAttempts` while still red;
 *   sticky until a green check or a fresh watch (a new PR) resets it.
 * - `'user_stop'` — a client sent `ci_auto_iterate_stop`; sticky the same
 *   way as `'max_attempts'`.
 * - `'ineligible'` — the session was paused or over its effective spend
 *   cap (SPEC §7.16; issue #251) at the moment a new failure arrived, so
 *   THIS failure was skipped without spending an attempt. NOT sticky: a
 *   later new failure re-checks eligibility fresh, since a pause/cap can
 *   be lifted at any moment and every new failure deserves its own look.
 */
export const ciAutoIterateStopReasonV1 = z.enum([
  'green',
  'max_attempts',
  'user_stop',
  'ineligible',
]);
export type CiAutoIterateStopReasonV1 = z.infer<typeof ciAutoIterateStopReasonV1>;

/** One recorded auto-iterate attempt — "a record of what it tried" — deliberately just enough for a client to render a timeline (which numbered attempt, against which failing commit, when), never the prompt text itself (already covered by the session's own transcript). */
export const ciAutoIterateAttemptV1 = z.object({
  /** 1-indexed, monotonically increasing within one loop; reset to counting from 1 again the moment a green check (or a fresh watch) starts a new loop. */
  attempt: z.number().int().positive(),
  /** The failing commit's own `headSha` (`CiCheckStateV1.headSha`) this attempt reacted to. */
  headSha: z.string().min(1),
  /** Epoch ms this attempt's `promptSession` call was made. */
  promptedAt: z.number(),
});
export type CiAutoIterateAttemptV1 = z.infer<typeof ciAutoIterateAttemptV1>;

/** One session's current auto-iterate loop state — what `ci_auto_iterate_status`'s envelope decrypts to (wrapped in {@link CiAutoIterateStatusPayloadV1}), and also `CiAutoIterateController`'s own in-memory snapshot shape (`packages/node/src/ci-auto-iterate.ts`), reused as-is rather than a second parallel type (mirrors `ci-check.ts`'s own `CiCheckStateV1` doing the same for `CiCheckWatcher`). */
export const ciAutoIterateStateV1 = z.object({
  /** `true` while the loop just drove (or is about to drive) an agent turn and hasn't yet stopped; `false` once it has (see `stoppedReason`) or before it has ever started. */
  active: z.boolean(),
  /** How many attempts this loop has spent so far, within the CURRENT loop (reset to 0 on a green check or a fresh watch). */
  attempts: z.number().int().nonnegative(),
  /** The bound `attempts` is never allowed to exceed — "never let it spin forever" (issue #246's own acceptance line). */
  maxAttempts: z.number().int().positive(),
  /** Why the loop isn't currently `active` — `undefined` while `active` is `true`, or before this session has ever had a CI failure to react to. */
  stoppedReason: ciAutoIterateStopReasonV1.optional(),
  /** Every attempt this loop has made so far, oldest first — reset alongside `attempts` on a green check or a fresh watch. */
  history: z.array(ciAutoIterateAttemptV1),
});
export type CiAutoIterateStateV1 = z.infer<typeof ciAutoIterateStateV1>;

/** The plaintext a `ci_auto_iterate_status` envelope decrypts to. */
export const ciAutoIterateStatusPayloadV1 = z.object({
  state: ciAutoIterateStateV1,
});
export type CiAutoIterateStatusPayloadV1 = z.infer<typeof ciAutoIterateStatusPayloadV1>;

/** Parses and validates a decrypted `ci_auto_iterate_status` payload, throwing on an invalid one. */
export function parseCiAutoIterateStatusPayloadV1(data: unknown): CiAutoIterateStatusPayloadV1 {
  return ciAutoIterateStatusPayloadV1.parse(data);
}

/** Same as {@link parseCiAutoIterateStatusPayloadV1} but never throws; returns zod's result. */
export function safeParseCiAutoIterateStatusPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, CiAutoIterateStatusPayloadV1> {
  return ciAutoIterateStatusPayloadV1.safeParse(data);
}

/**
 * The owning node streams a session's current auto-iterate loop state —
 * sent right after a decision is made on a new CI failure (whether it
 * proceeded or was skipped), and again whenever the loop stops (green,
 * max attempts, or a user stop). Fanned out to a session's subscribed
 * clients exactly like `ci_check_status`; the relay never opens the
 * envelope.
 */
export const ciAutoIterateStatus = z.object({
  type: z.literal('ci_auto_iterate_status'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type CiAutoIterateStatus = z.infer<typeof ciAutoIterateStatus>;

/**
 * A client asks the owning node to stop `sessionId`'s auto-iterate loop
 * right now — "a way to stop, ... user-initiated" (issue #246's own
 * acceptance line). Envelope-less and reply-less, mirroring `run_cancel`'s
 * own "cancelling carries no content" shape: the resulting
 * `ci_auto_iterate_status` push (`stoppedReason: 'user_stop'`) is the
 * confirmation. A silent no-op when `sessionId` isn't one of this node's
 * sessions, or the loop wasn't actually active — mirrors `run_cancel`'s
 * own "already exited or unknown" no-op.
 */
export const ciAutoIterateStop = z.object({
  type: z.literal('ci_auto_iterate_stop'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
});
export type CiAutoIterateStop = z.infer<typeof ciAutoIterateStop>;
