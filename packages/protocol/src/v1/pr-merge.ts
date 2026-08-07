import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Merging a session's open pull request (SPEC §7.14 "...and merge"; issue
 * #240) — the explicit action the human half of the PR loop ends on.
 * `packages/node/src/pr-merge.ts`'s `mergePr` is what actually talks to
 * GitHub: a direct REST call through the same SPEC §7.26 connected-
 * account credential `ci-check-watcher.ts` already established for
 * reading a PR's state, never `gh` — see that module's own doc comment
 * for why merging, unlike opening a PR (`pr-open.ts`), never runs on the
 * session's execution target at all: nothing about "is this PR clean to
 * merge" needs a checkout, a working tree, or `gh`'s own session-scoped
 * auth.
 *
 * One request/reply pair, both sealed exactly like `pr_open_request`/
 * `pr_open_result`: the request carries the operator's chosen merge
 * method, the result carries either the merged commit's sha or — the
 * point of this whole file — an HONEST reason it did not merge.
 * `PrMergeOutcome` is a discriminated union, never a bare boolean or one
 * collapsed error string, because "blocked by a still-pending review" and
 * "this branch now conflicts with its base" are different facts a client
 * renders differently and a human acts on differently (SPEC §7.14
 * "reports success/failure clearly").
 */

export const prMergeMethod = z.enum(['merge', 'squash', 'rebase']);
export type PrMergeMethod = z.infer<typeof prMergeMethod>;

/**
 * Why a PR that is still open and not yet merged can't be merged right
 * now — GitHub's own `mergeable_state` vocabulary folded down to what a
 * client actually needs to render distinctly, not passed through
 * verbatim: GitHub's full vocabulary (`dirty`/`unknown`/`blocked`/
 * `behind`/`unstable`/`draft`/`clean`/...) mixes "not mergeable" reasons
 * with "still computing" and "actually a conflict", both of which are
 * their own {@link PrMergeOutcome} member below rather than folded in
 * here.
 */
export const prMergeBlockedReason = z.enum([
  /** The PR is a draft — GitHub refuses to merge a draft outright. */
  'draft',
  /** The PR was closed without merging. */
  'closed',
  /** A branch protection rule this token can see isn't satisfied yet — a still-pending required review, a still-failing or still-pending required status check, or both; GitHub's own `mergeable_state: 'blocked'`/`'unstable'` don't disambiguate the two further, and this module doesn't fabricate a precision GitHub itself doesn't report. */
  'requirements_not_met',
  /** The base branch has moved and this PR's branch needs updating first (`mergeable_state: 'behind'`). */
  'behind_base',
  /** GitHub reported some other non-mergeable state this vocabulary doesn't name. */
  'unknown',
]);
export type PrMergeBlockedReason = z.infer<typeof prMergeBlockedReason>;

export const prMergeFailureCategory = z.enum([
  /** No usable GitHub credential resolved for this project (SPEC §7.26) — never even attempted a call. */
  'no_credential',
  /** This session has no watched PR at all (never opened one, or the watch was lost). */
  'no_pr',
  /** GitHub rejected or errored the request for a reason outside every named outcome above (a 404, a permissions error, a malformed response, ...). */
  'unknown',
]);
export type PrMergeFailureCategory = z.infer<typeof prMergeFailureCategory>;

const prMergeBlockedOutcome = z.object({
  outcome: z.literal('blocked'),
  reason: prMergeBlockedReason,
});

const prMergeFailedOutcome = z.object({
  outcome: z.literal('failed'),
  category: prMergeFailureCategory,
  detail: z.string().optional(),
});

/** `pr_merge_result`'s own outcome — see this file's own doc comment for why every branch is named rather than collapsed. */
export const prMergeOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('merged'), sha: z.string().min(1) }),
  z.object({ outcome: z.literal('already_merged') }),
  /** GitHub is still computing this PR's mergeability (`mergeable: null`) — genuinely transient, distinct from `'blocked'`: retrying shortly, not fixing anything, is the correct next step. */
  z.object({ outcome: z.literal('not_ready') }),
  prMergeBlockedOutcome,
  z.object({ outcome: z.literal('conflict') }),
  prMergeFailedOutcome,
]);
export type PrMergeOutcome = z.infer<typeof prMergeOutcome>;

/** The plaintext a `pr_merge_request` envelope decrypts to — the operator's own chosen merge method, composed in the client's form. */
export const prMergeRequestPayloadV1 = z.object({
  method: prMergeMethod,
});
export type PrMergeRequestPayloadV1 = z.infer<typeof prMergeRequestPayloadV1>;

/** Parses and validates a decrypted `pr_merge_request` payload, throwing on an invalid one. */
export function parsePrMergeRequestPayloadV1(data: unknown): PrMergeRequestPayloadV1 {
  return prMergeRequestPayloadV1.parse(data);
}

/** Same as {@link parsePrMergeRequestPayloadV1} but never throws; returns zod's result. */
export function safeParsePrMergeRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, PrMergeRequestPayloadV1> {
  return prMergeRequestPayloadV1.safeParse(data);
}

/** A client asks the owning node to merge `sessionId`'s watched pull request — the one message in this file with a real side effect on the operator's actual repository. The node re-reads the PR's current mergeability fresh right before acting (`packages/node/src/pr-merge.ts`'s `mergePr`), never trusting a client-held reading as current. */
export const prMergeRequest = z.object({
  type: z.literal('pr_merge_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type PrMergeRequest = z.infer<typeof prMergeRequest>;

/** The plaintext a `pr_merge_result` envelope decrypts to. */
export const prMergeResultPayloadV1 = z.object({
  result: prMergeOutcome,
});
export type PrMergeResultPayloadV1 = z.infer<typeof prMergeResultPayloadV1>;

/** Parses and validates a decrypted `pr_merge_result` payload, throwing on an invalid one. */
export function parsePrMergeResultPayloadV1(data: unknown): PrMergeResultPayloadV1 {
  return prMergeResultPayloadV1.parse(data);
}

/** Same as {@link parsePrMergeResultPayloadV1} but never throws; returns zod's result. */
export function safeParsePrMergeResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, PrMergeResultPayloadV1> {
  return prMergeResultPayloadV1.safeParse(data);
}

/** The owning node's reply to `pr_merge_request`. Fanned out to a session's subscribed clients exactly like `pr_open_result`. */
export const prMergeResult = z.object({
  type: z.literal('pr_merge_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type PrMergeResult = z.infer<typeof prMergeResult>;
