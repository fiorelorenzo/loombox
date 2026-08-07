import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Stash save/list/pop/drop (SPEC §7.6; issue #234) — `git-branch.ts`'s
 * sibling, split out because a stash addresses a *stack* of saved
 * snapshots by index rather than a branch name, not because the git
 * plumbing differs (both run real `git` subcommands through
 * `ExecutionTarget.exec`, `packages/node/src/git-diff.ts`'s
 * `listStashes`/`stashSave`/`stashPop`/`stashDrop`).
 *
 * `git_stash_save_request` always passes `-u` (include untracked) — this
 * app's `computeWorktreeDiff`/`computeHunkDiff` already treat an
 * untracked file as a real, visible worktree change (`git-diff.ts`'s own
 * `buildUntrackedHunkFile` doc comment); leaving one behind on stash
 * would silently disagree with what the diff viewer just showed as
 * "changed". `outcome: 'ok'` still distinguishes `created: false` — real
 * git behaviour when there is nothing to stash ("No local changes to
 * save", exit 0) — from an actual new stash entry, so a client never
 * claims to have stashed something it didn't.
 *
 * `git_stash_pop_request`'s own acceptance-bar failure mode: a pop that
 * cannot complete cleanly. Real `git stash pop` leaves the worktree
 * conflict-marked AND — its own safety behaviour — never drops the
 * stash entry on a failed pop, so nothing is lost either way. This
 * reports `'conflict'` with the unmerged paths (same
 * `git diff --name-only --diff-filter=U` this file's `git-branch.ts`
 * sibling already uses for a merge conflict) plus a `stashKept: true`
 * note, rather than a bare thrown error — the honest, actionable state
 * issue #234 asks for. `git_stash_drop_request` is the way out once
 * conflicts are resolved (or to discard a pop attempt outright): drop
 * the now-redundant stash entry after `git add`-ing/reverting the
 * conflict-marked files by hand (the file tree/editor, §7.4, or an
 * integrated terminal, §7.5).
 */

export const gitStashSummaryV1 = z.object({
  index: z.number().int().nonnegative(),
  message: z.string(),
});
export type GitStashSummaryV1 = z.infer<typeof gitStashSummaryV1>;

const gitStashErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string(),
});

const gitStashNotFoundV1 = z.object({
  outcome: z.literal('not_found'),
  message: z.string(),
});

// ---- git_stash_save ----

/** The plaintext a `git_stash_save_request` envelope decrypts to — a stash `message` is real session content (may echo file/branch names), so this travels sealed like `git_hunk_action_request`'s own enveloped `path`. */
export const gitStashSaveRequestPayloadV1 = z.object({
  message: z.string().nullable(),
});
export type GitStashSaveRequestPayloadV1 = z.infer<typeof gitStashSaveRequestPayloadV1>;

export function parseGitStashSaveRequestPayloadV1(data: unknown): GitStashSaveRequestPayloadV1 {
  return gitStashSaveRequestPayloadV1.parse(data);
}

export function safeParseGitStashSaveRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitStashSaveRequestPayloadV1> {
  return gitStashSaveRequestPayloadV1.safeParse(data);
}

export const gitStashSaveRequest = z.object({
  type: z.literal('git_stash_save_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitStashSaveRequest = z.infer<typeof gitStashSaveRequest>;

const gitStashSaveResultV1 = z.object({
  outcome: z.literal('ok'),
  created: z.boolean(),
});

/** The plaintext a `git_stash_save_response` envelope decrypts to. */
export const gitStashSaveResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitStashSaveResultV1,
  gitStashErrorV1,
]);
export type GitStashSaveResponsePayloadV1 = z.infer<typeof gitStashSaveResponsePayloadV1>;

export function parseGitStashSaveResponsePayloadV1(data: unknown): GitStashSaveResponsePayloadV1 {
  return gitStashSaveResponsePayloadV1.parse(data);
}

export function safeParseGitStashSaveResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitStashSaveResponsePayloadV1> {
  return gitStashSaveResponsePayloadV1.safeParse(data);
}

export const gitStashSaveResponse = z.object({
  type: z.literal('git_stash_save_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitStashSaveResponse = z.infer<typeof gitStashSaveResponse>;

// ---- git_stash_list ----

/** A client asks the owning node for one session's current stash stack. No envelope — asking carries no content, same reasoning as `git_diff_request`. */
export const gitStashListRequest = z.object({
  type: z.literal('git_stash_list_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type GitStashListRequest = z.infer<typeof gitStashListRequest>;

const gitStashListResultV1 = z.object({
  outcome: z.literal('ok'),
  stashes: z.array(gitStashSummaryV1),
});

/** The plaintext a `git_stash_list_response` envelope decrypts to. */
export const gitStashListResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitStashListResultV1,
  gitStashErrorV1,
]);
export type GitStashListResponsePayloadV1 = z.infer<typeof gitStashListResponsePayloadV1>;

export function parseGitStashListResponsePayloadV1(data: unknown): GitStashListResponsePayloadV1 {
  return gitStashListResponsePayloadV1.parse(data);
}

export function safeParseGitStashListResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitStashListResponsePayloadV1> {
  return gitStashListResponsePayloadV1.safeParse(data);
}

export const gitStashListResponse = z.object({
  type: z.literal('git_stash_list_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitStashListResponse = z.infer<typeof gitStashListResponse>;

// ---- git_stash_pop ----

/** The plaintext a `git_stash_pop_request` envelope decrypts to. `index` omitted/`null` pops `stash@{0}` (the most recent), same as bare `git stash pop`. */
export const gitStashPopRequestPayloadV1 = z.object({
  index: z.number().int().nonnegative().nullable(),
});
export type GitStashPopRequestPayloadV1 = z.infer<typeof gitStashPopRequestPayloadV1>;

export function parseGitStashPopRequestPayloadV1(data: unknown): GitStashPopRequestPayloadV1 {
  return gitStashPopRequestPayloadV1.parse(data);
}

export function safeParseGitStashPopRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitStashPopRequestPayloadV1> {
  return gitStashPopRequestPayloadV1.safeParse(data);
}

export const gitStashPopRequest = z.object({
  type: z.literal('git_stash_pop_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitStashPopRequest = z.infer<typeof gitStashPopRequest>;

const gitStashPopResultV1 = z.object({
  outcome: z.literal('ok'),
});

/** A pop that could not complete cleanly (issue #234's own acceptance bar: "a stash that cannot pop") — real `git stash pop` conflict-markers the worktree and, its own safety behaviour, keeps the stash entry rather than dropping it. `stashKept` is always `true` here (documented explicitly, not left implicit) so a client can say so rather than let a caller assume the usual "the stash is gone" postcondition. */
const gitStashPopConflictV1 = z.object({
  outcome: z.literal('conflict'),
  message: z.string(),
  conflictedPaths: z.array(z.string()),
  stashKept: z.literal(true),
});

/** The plaintext a `git_stash_pop_response` envelope decrypts to. */
export const gitStashPopResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitStashPopResultV1,
  gitStashPopConflictV1,
  gitStashNotFoundV1,
  gitStashErrorV1,
]);
export type GitStashPopResponsePayloadV1 = z.infer<typeof gitStashPopResponsePayloadV1>;

export function parseGitStashPopResponsePayloadV1(data: unknown): GitStashPopResponsePayloadV1 {
  return gitStashPopResponsePayloadV1.parse(data);
}

export function safeParseGitStashPopResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitStashPopResponsePayloadV1> {
  return gitStashPopResponsePayloadV1.safeParse(data);
}

export const gitStashPopResponse = z.object({
  type: z.literal('git_stash_pop_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitStashPopResponse = z.infer<typeof gitStashPopResponse>;

// ---- git_stash_drop ----

/** The plaintext a `git_stash_drop_request` envelope decrypts to. */
export const gitStashDropRequestPayloadV1 = z.object({
  index: z.number().int().nonnegative(),
});
export type GitStashDropRequestPayloadV1 = z.infer<typeof gitStashDropRequestPayloadV1>;

export function parseGitStashDropRequestPayloadV1(data: unknown): GitStashDropRequestPayloadV1 {
  return gitStashDropRequestPayloadV1.parse(data);
}

export function safeParseGitStashDropRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitStashDropRequestPayloadV1> {
  return gitStashDropRequestPayloadV1.safeParse(data);
}

export const gitStashDropRequest = z.object({
  type: z.literal('git_stash_drop_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitStashDropRequest = z.infer<typeof gitStashDropRequest>;

const gitStashDropResultV1 = z.object({
  outcome: z.literal('ok'),
});

/** The plaintext a `git_stash_drop_response` envelope decrypts to. */
export const gitStashDropResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitStashDropResultV1,
  gitStashNotFoundV1,
  gitStashErrorV1,
]);
export type GitStashDropResponsePayloadV1 = z.infer<typeof gitStashDropResponsePayloadV1>;

export function parseGitStashDropResponsePayloadV1(data: unknown): GitStashDropResponsePayloadV1 {
  return gitStashDropResponsePayloadV1.parse(data);
}

export function safeParseGitStashDropResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitStashDropResponsePayloadV1> {
  return gitStashDropResponsePayloadV1.safeParse(data);
}

export const gitStashDropResponse = z.object({
  type: z.literal('git_stash_drop_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitStashDropResponse = z.infer<typeof gitStashDropResponse>;
