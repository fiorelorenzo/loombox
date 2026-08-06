import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Commit workflow with AI-generated commit messages (SPEC §7.6; issue
 * #233) — #232's hunk-level staging own next step: the index is now
 * something a user can actually curate (`git_hunk_action_request`'s own
 * stage/unstage/discard), so this is "commit what's staged, with a
 * message the session's own agent drafts from the staged diff."
 *
 * Two message pairs:
 * - `git_commit_draft_request`/`git_commit_draft_response`: asks the
 *   owning node to draft a commit message from the CURRENT staged diff.
 *   No envelope on the request — asking carries no content, same
 *   reasoning as `git_hunk_diff_request`. The draft itself is generated
 *   by prompting the session's own live agent (`packages/node/src/
 *   git-commit.ts`'s own doc comment explains why — never a new,
 *   separately-configured provider call), so it can fail for reasons
 *   `git_hunk_diff_request` never has to consider: no live agent for this
 *   session, or nothing staged to draft from. The reply carries real
 *   session content (the draft text), so it travels sealed.
 * - `git_commit_request`/`git_commit_response`: the operator's own
 *   explicit "commit" action — `message` is the draft accepted verbatim
 *   OR edited first; this pair carries no notion of "was it edited",
 *   only the final text, matching `pr_open_request`'s own "whatever the
 *   operator's form currently holds" shape. Enveloped like
 *   `git_hunk_action_request`: the message is real session content. The
 *   one message in this file with a real side effect on the operator's
 *   actual repository — nothing here is ever sent except from an
 *   explicit confirm click (`CommitDialog.svelte`'s own file doc
 *   comment), never automatically once a draft arrives.
 *
 * Runs real `git` subcommands through `ExecutionTarget.exec` exactly
 * like `git-diff.ts`/`git-hunks.ts` (`packages/node/src/git-commit.ts`'s
 * `commitStaged`) — works identically for a `local` or an `ssh:` target.
 */

/** A client asks the owning node to draft a commit message from one session's currently staged diff. No envelope — see the file doc comment. Fresh every call, like `git_hunk_diff_request`; there is no persistent subscription, and a caller re-issues this (a fresh `requestId`) to regenerate after further staging changes. */
export const gitCommitDraftRequest = z.object({
  type: z.literal('git_commit_draft_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type GitCommitDraftRequest = z.infer<typeof gitCommitDraftRequest>;

/** The successful outcome: the agent's own drafted commit message, verbatim — never itself committed to anything. */
const gitCommitDraftResultV1 = z.object({
  outcome: z.literal('ok'),
  message: z.string(),
});

/** A failed draft: no live agent for this session, nothing staged to draft from, or the agent's own reply was empty. */
const gitCommitDraftErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string(),
});

/** The plaintext a `git_commit_draft_response` envelope decrypts to. */
export const gitCommitDraftResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitCommitDraftResultV1,
  gitCommitDraftErrorV1,
]);
export type GitCommitDraftResponsePayloadV1 = z.infer<typeof gitCommitDraftResponsePayloadV1>;

/** Parses and validates a decrypted `git_commit_draft_response` payload, throwing on an invalid one. */
export function parseGitCommitDraftResponsePayloadV1(
  data: unknown,
): GitCommitDraftResponsePayloadV1 {
  return gitCommitDraftResponsePayloadV1.parse(data);
}

/** Same as {@link parseGitCommitDraftResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseGitCommitDraftResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitCommitDraftResponsePayloadV1> {
  return gitCommitDraftResponsePayloadV1.safeParse(data);
}

/** The owning node's reply to `git_commit_draft_request`. Fanned out to a session's subscribed clients exactly like `git_hunk_diff_response` — a requesting client filters on `requestId`. */
export const gitCommitDraftResponse = z.object({
  type: z.literal('git_commit_draft_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitCommitDraftResponse = z.infer<typeof gitCommitDraftResponse>;

/** The plaintext a `git_commit_request` envelope decrypts to — the operator's own final message text (draft accepted verbatim, or edited first). */
export const gitCommitRequestPayloadV1 = z.object({
  message: z.string().min(1),
});
export type GitCommitRequestPayloadV1 = z.infer<typeof gitCommitRequestPayloadV1>;

/** Parses and validates a decrypted `git_commit_request` payload, throwing on an invalid one. */
export function parseGitCommitRequestPayloadV1(data: unknown): GitCommitRequestPayloadV1 {
  return gitCommitRequestPayloadV1.parse(data);
}

/** Same as {@link parseGitCommitRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseGitCommitRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitCommitRequestPayloadV1> {
  return gitCommitRequestPayloadV1.safeParse(data);
}

/** A client asks the owning node to commit whatever is currently staged with `message`. Routed to the owning node exactly like `git_hunk_action_request`; the relay only ever sees `sessionId`/`requestId` plus this opaque `EncryptedEnvelope` — the commit message itself never reaches the relay in the clear (SPEC §8's metadata boundary). */
export const gitCommitRequest = z.object({
  type: z.literal('git_commit_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitCommitRequest = z.infer<typeof gitCommitRequest>;

/** The successful outcome: the commit landed, at this sha. */
const gitCommitResultV1 = z.object({
  outcome: z.literal('ok'),
  sha: z.string(),
});

/** A failed commit: an empty index (nothing staged — the operator's own draft/edit may now be stale), an empty message, or the underlying `git commit` command failing for some other reason (e.g. no committer identity configured). */
const gitCommitErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string(),
});

/** The plaintext a `git_commit_response` envelope decrypts to. */
export const gitCommitResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitCommitResultV1,
  gitCommitErrorV1,
]);
export type GitCommitResponsePayloadV1 = z.infer<typeof gitCommitResponsePayloadV1>;

/** Parses and validates a decrypted `git_commit_response` payload, throwing on an invalid one. */
export function parseGitCommitResponsePayloadV1(data: unknown): GitCommitResponsePayloadV1 {
  return gitCommitResponsePayloadV1.parse(data);
}

/** Same as {@link parseGitCommitResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseGitCommitResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitCommitResponsePayloadV1> {
  return gitCommitResponsePayloadV1.safeParse(data);
}

/** The owning node's reply to `git_commit_request`. Fanned out to a session's subscribed clients exactly like `git_hunk_action_response` above. */
export const gitCommitResponse = z.object({
  type: z.literal('git_commit_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitCommitResponse = z.infer<typeof gitCommitResponse>;
