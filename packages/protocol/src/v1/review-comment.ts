import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Review comments on a session's open pull request (SPEC §7.14 "handle
 * review comments"; issue #240) — the human half of the PR loop
 * `ci-check.ts`/#239 already built the CI half of:
 * `packages/node/src/review-comment-watcher.ts` polls a watched PR's
 * review threads (GitHub's GraphQL `reviewThreads` connection — the only
 * GitHub API surface that exposes a thread's resolved/unresolved state at
 * all; the REST `pulls/{n}/comments` endpoint returns individual comments
 * with no thread-resolution field whatsoever) and this file carries the
 * result back over the wire, mirroring `ci-check.ts`'s own
 * `ci_check_status` shape almost exactly.
 *
 * One node-pushed message, no request: `review_comment_status` streams a
 * session's latest known review-thread state to its subscribed clients,
 * the same "arrives whenever the node's own poll produces a fresh
 * reading" contract as `ci_check_status`. Session-scoped and
 * envelope-sealed for the same reason: a review comment's own body text
 * is real, sometimes sensitive, project content.
 *
 * `ReviewCommentThreadV1` carries only UNRESOLVED threads (see
 * `ReviewCommentWatcher.fetchState`'s own doc comment) — a resolved
 * thread simply stops appearing in the next poll's `threads` array, which
 * is deliberately the ENTIRE mechanism behind "a resolved thread clears
 * [the inbox item]" (issue #240's acceptance): no separate "cleared"
 * event, no client-side bookkeeping of thread ids across polls, just "is
 * it still in the list" — the exact same "state, not a diff" contract
 * `CiCheckStateV1.checkRuns` already established.
 *
 * `ReviewCommentOverallStateV1` mirrors `CiCheckOverallStateV1`'s shape
 * but simpler — there is no in-progress analogue to CI's `'pending'`, a
 * review thread is either open or it isn't:
 * - `'unknown'` — no credential to poll with yet, or the very first poll
 *   hasn't completed.
 * - `'clear'` — polled successfully, zero unresolved threads.
 * - `'pending'` — polled successfully, at least one unresolved thread;
 *   see `threads`.
 */

export const reviewCommentThreadV1 = z.object({
  /** The GraphQL review-thread node id (`PRRT_...`) — stable across polls; identifies which conversation this is, distinct from {@link commentId} below. */
  threadId: z.string().min(1),
  /** The thread's latest comment's own GraphQL node id — what `ReviewCommentWatcher`'s own dedup keys on (see that module's doc comment for why this, not `threadId`, is the right dedup key: a thread can gain a second, third, ... reply while staying unresolved, and each is its own "new comment" event). */
  commentId: z.string().min(1),
  /** The file path this thread is anchored to — absent for a thread left on the PR's "Files changed" overview rather than a specific line (GraphQL's own `path` is nullable for exactly that case). */
  path: z.string().optional(),
  /** The line this thread is anchored to — absent when `path` is (see above), or when the underlying diff line no longer exists (an outdated thread GitHub still reports as unresolved). */
  line: z.number().int().optional(),
  /** The thread's latest comment: who wrote it, what it says, and when — enough for a client to render the thread and, if the operator chooses, forward it into the session as a follow-up prompt (issue #240's "sent to the session as a prompt" acceptance line) via the existing `prompt_inject` message, composed client-side from these same fields; no separate wire message exists for that step, the same way no separate message exists for "reply to a normal chat message". */
  authorLogin: z.string().optional(),
  body: z.string(),
  createdAt: z.string(),
  /** A permalink to the comment on GitHub, when the API returned one. */
  url: z.string().optional(),
});
export type ReviewCommentThreadV1 = z.infer<typeof reviewCommentThreadV1>;

export const reviewCommentOverallStateV1 = z.enum(['unknown', 'clear', 'pending']);
export type ReviewCommentOverallStateV1 = z.infer<typeof reviewCommentOverallStateV1>;

/** One session's latest known review-thread state — what `review_comment_status`'s envelope decrypts to (wrapped in {@link ReviewCommentStatusPayloadV1}), and also `ReviewCommentWatcher`'s own in-memory snapshot shape (`packages/node/src/review-comment-watcher.ts`), reused as-is rather than a second parallel type — mirrors `CiCheckStateV1`'s identical reuse. */
export const reviewCommentStateV1 = z.object({
  state: reviewCommentOverallStateV1,
  prUrl: z.string(),
  prNumber: z.number().int().positive(),
  /** Every currently-unresolved thread — see this file's own doc comment for why a resolved one simply stops appearing rather than being reported some other way. Empty whenever `state` isn't `'pending'`. */
  threads: z.array(reviewCommentThreadV1),
  updatedAt: z.number(),
});
export type ReviewCommentStateV1 = z.infer<typeof reviewCommentStateV1>;

/** The plaintext a `review_comment_status` envelope decrypts to. */
export const reviewCommentStatusPayloadV1 = z.object({
  status: reviewCommentStateV1,
});
export type ReviewCommentStatusPayloadV1 = z.infer<typeof reviewCommentStatusPayloadV1>;

/** Parses and validates a decrypted `review_comment_status` payload, throwing on an invalid one. */
export function parseReviewCommentStatusPayloadV1(data: unknown): ReviewCommentStatusPayloadV1 {
  return reviewCommentStatusPayloadV1.parse(data);
}

/** Same as {@link parseReviewCommentStatusPayloadV1} but never throws; returns zod's result. */
export function safeParseReviewCommentStatusPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, ReviewCommentStatusPayloadV1> {
  return reviewCommentStatusPayloadV1.safeParse(data);
}

/**
 * The owning node streams a session's latest review-thread state — sent
 * right after a session's PR is first watched (SPEC §7.14, issue #238's
 * `registerReviewCommentWatch`) and on every subsequent poll thereafter,
 * whatever the resulting state, exactly mirroring `ci_check_status`'s own
 * push contract.
 */
export const reviewCommentStatus = z.object({
  type: z.literal('review_comment_status'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type ReviewCommentStatus = z.infer<typeof reviewCommentStatus>;
