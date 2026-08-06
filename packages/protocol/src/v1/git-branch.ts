import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Branch-level create/switch/merge (SPEC §7.6; issue #234) — the "commit
 * graph and branch tree" half of git management that `git-diff.ts`/
 * `git-hunks.ts` (issues #206/#232) don't cover: those report *content*
 * (a diff, a staged/unstaged hunk breakdown); this reports and mutates
 * *which branch* a session's worktree is on, and folds another branch's
 * history into it. `git-stash.ts`'s stash pair is this file's sibling —
 * split out only because stash addresses a *stack* of saved snapshots
 * rather than a branch name, not because the git plumbing differs.
 *
 * Five message pairs, all session-scoped exactly like `git_diff_request`:
 * - `git_branch_list_request`/`_response`: read-only, envelope-less like
 *   `git_diff_request` (asking carries no content) — every local branch
 *   plus which one is current, so a client has something to populate a
 *   switch/merge picker from.
 * - `git_branch_create_request`/`_response`: enveloped (a branch `name`
 *   is real session content, mirrors `git_hunk_action_request`'s own
 *   enveloped `path`). `checkout: true` also switches onto the new
 *   branch — same dirty-worktree/fixed-branch guard as
 *   `git_branch_switch_request` below, since it is that switch under the
 *   hood.
 * - `git_branch_switch_request`/`_response`: enveloped. Two honest,
 *   actionable non-`'ok'` outcomes instead of a bare thrown error
 *   (issue #234's own acceptance bar): `'dirty_worktree'` — real `git
 *   checkout` output ("Your local changes... would be overwritten")
 *   parsed into the actual conflicting `paths`, so a client can offer
 *   "stash and switch" rather than just print git's own paragraph; and
 *   `'session_branch_fixed'` — refused *before* touching git at all, for
 *   a worktree-isolated session (`Session.branch !== ''`,
 *   `session-manager.ts`'s own doc comment: that worktree's branch never
 *   moves for the session's whole life). Switching it out from under the
 *   session would silently break `resolveSessionBranch`'s cached report
 *   and `SessionManager.removeSession`'s own `git branch -D` teardown —
 *   the "session's own worktree left in a state the user can't get out
 *   of from the UI" failure mode this issue calls out by name. A
 *   worktree-less (`ssh:`) or work-in-place session (`branch === ''`)
 *   has no such invariant and switches freely.
 * - `git_branch_merge_request`/`_response`: enveloped. Merging a branch
 *   IN never moves the checked-out branch, so this has no
 *   `'session_branch_fixed'` guard — an isolated session merging `main`
 *   into its own `loombox/session-<id>` to pick up upstream changes is
 *   exactly the intended use. `'conflict'` reports every unmerged path
 *   (`git diff --name-only --diff-filter=U`) rather than swallowing git's
 *   own nonzero exit — the state a client renders and a person resolves
 *   (edit the conflict markers through the file tree/editor, §7.4, or an
 *   integrated terminal, §7.5) or backs out of via
 *   `git_branch_merge_abort_request` below.
 * - `git_branch_merge_abort_request`/`_response`: envelope-less (nothing
 *   to carry beyond session/request id, mirrors `git_diff_request`) —
 *   the other half of "resolve or abort" for a `'conflict'` outcome
 *   above. `'error'` when there is no merge in progress to abort.
 *
 * Runs real `git` subcommands through `ExecutionTarget.exec`
 * (`packages/node/src/git-diff.ts`'s own `listBranches`/`createBranch`/
 * `switchBranch`/`mergeBranch`/`abortMerge`) — the same seam `git-diff.ts`
 * and `git-hunks.ts` already established, works identically for a
 * `local` or an `ssh:` target.
 */

export const gitBranchSummaryV1 = z.object({
  name: z.string().min(1),
  current: z.boolean(),
});
export type GitBranchSummaryV1 = z.infer<typeof gitBranchSummaryV1>;

/** Shared by `git_branch_switch_response`/`git_branch_create_response`: real `git checkout`/`git switch` output ("Your local changes to the following files would be overwritten...") parsed into the actual list of conflicting paths, never a bare passthrough of git's own paragraph. */
const gitBranchDirtyWorktreeV1 = z.object({
  outcome: z.literal('dirty_worktree'),
  message: z.string(),
  paths: z.array(z.string()),
});

/** Shared by `git_branch_switch_response`/`git_branch_create_response`: refused before touching git, for a worktree-isolated session whose branch is fixed for its whole life — see this file's own doc comment. */
const gitBranchFixedV1 = z.object({
  outcome: z.literal('session_branch_fixed'),
  message: z.string(),
});

const gitBranchErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string(),
});

// ---- git_branch_list ----

/** A client asks the owning node for one session's current local branches. No envelope — asking carries no content, same reasoning as `git_diff_request`. */
export const gitBranchListRequest = z.object({
  type: z.literal('git_branch_list_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type GitBranchListRequest = z.infer<typeof gitBranchListRequest>;

const gitBranchListResultV1 = z.object({
  outcome: z.literal('ok'),
  branches: z.array(gitBranchSummaryV1),
});

/** The plaintext a `git_branch_list_response` envelope decrypts to. */
export const gitBranchListResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitBranchListResultV1,
  gitBranchErrorV1,
]);
export type GitBranchListResponsePayloadV1 = z.infer<typeof gitBranchListResponsePayloadV1>;

/** Parses and validates a decrypted `git_branch_list_response` payload, throwing on an invalid one. */
export function parseGitBranchListResponsePayloadV1(data: unknown): GitBranchListResponsePayloadV1 {
  return gitBranchListResponsePayloadV1.parse(data);
}

/** Same as {@link parseGitBranchListResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseGitBranchListResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitBranchListResponsePayloadV1> {
  return gitBranchListResponsePayloadV1.safeParse(data);
}

export const gitBranchListResponse = z.object({
  type: z.literal('git_branch_list_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitBranchListResponse = z.infer<typeof gitBranchListResponse>;

// ---- git_branch_create ----

/** The plaintext a `git_branch_create_request` envelope decrypts to. `startPoint` defaults to `HEAD` (omitted/`null`) when not given. `checkout` also switches onto the new branch, subject to the same guard `git_branch_switch_request` enforces. */
export const gitBranchCreateRequestPayloadV1 = z.object({
  name: z.string().min(1),
  startPoint: z.string().min(1).nullable(),
  checkout: z.boolean(),
});
export type GitBranchCreateRequestPayloadV1 = z.infer<typeof gitBranchCreateRequestPayloadV1>;

export function parseGitBranchCreateRequestPayloadV1(data: unknown): GitBranchCreateRequestPayloadV1 {
  return gitBranchCreateRequestPayloadV1.parse(data);
}

export function safeParseGitBranchCreateRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitBranchCreateRequestPayloadV1> {
  return gitBranchCreateRequestPayloadV1.safeParse(data);
}

export const gitBranchCreateRequest = z.object({
  type: z.literal('git_branch_create_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitBranchCreateRequest = z.infer<typeof gitBranchCreateRequest>;

const gitBranchCreateResultV1 = z.object({
  outcome: z.literal('ok'),
  branch: z.string(),
  checkedOut: z.boolean(),
});

const gitBranchAlreadyExistsV1 = z.object({
  outcome: z.literal('already_exists'),
  message: z.string(),
});

/** The plaintext a `git_branch_create_response` envelope decrypts to. */
export const gitBranchCreateResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitBranchCreateResultV1,
  gitBranchAlreadyExistsV1,
  gitBranchDirtyWorktreeV1,
  gitBranchFixedV1,
  gitBranchErrorV1,
]);
export type GitBranchCreateResponsePayloadV1 = z.infer<typeof gitBranchCreateResponsePayloadV1>;

export function parseGitBranchCreateResponsePayloadV1(
  data: unknown,
): GitBranchCreateResponsePayloadV1 {
  return gitBranchCreateResponsePayloadV1.parse(data);
}

export function safeParseGitBranchCreateResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitBranchCreateResponsePayloadV1> {
  return gitBranchCreateResponsePayloadV1.safeParse(data);
}

export const gitBranchCreateResponse = z.object({
  type: z.literal('git_branch_create_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitBranchCreateResponse = z.infer<typeof gitBranchCreateResponse>;

// ---- git_branch_switch ----

/** The plaintext a `git_branch_switch_request` envelope decrypts to. */
export const gitBranchSwitchRequestPayloadV1 = z.object({
  name: z.string().min(1),
});
export type GitBranchSwitchRequestPayloadV1 = z.infer<typeof gitBranchSwitchRequestPayloadV1>;

export function parseGitBranchSwitchRequestPayloadV1(data: unknown): GitBranchSwitchRequestPayloadV1 {
  return gitBranchSwitchRequestPayloadV1.parse(data);
}

export function safeParseGitBranchSwitchRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitBranchSwitchRequestPayloadV1> {
  return gitBranchSwitchRequestPayloadV1.safeParse(data);
}

export const gitBranchSwitchRequest = z.object({
  type: z.literal('git_branch_switch_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitBranchSwitchRequest = z.infer<typeof gitBranchSwitchRequest>;

const gitBranchSwitchResultV1 = z.object({
  outcome: z.literal('ok'),
  branch: z.string(),
});

const gitBranchNotFoundV1 = z.object({
  outcome: z.literal('not_found'),
  message: z.string(),
});

/** The plaintext a `git_branch_switch_response` envelope decrypts to. */
export const gitBranchSwitchResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitBranchSwitchResultV1,
  gitBranchNotFoundV1,
  gitBranchDirtyWorktreeV1,
  gitBranchFixedV1,
  gitBranchErrorV1,
]);
export type GitBranchSwitchResponsePayloadV1 = z.infer<typeof gitBranchSwitchResponsePayloadV1>;

export function parseGitBranchSwitchResponsePayloadV1(
  data: unknown,
): GitBranchSwitchResponsePayloadV1 {
  return gitBranchSwitchResponsePayloadV1.parse(data);
}

export function safeParseGitBranchSwitchResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitBranchSwitchResponsePayloadV1> {
  return gitBranchSwitchResponsePayloadV1.safeParse(data);
}

export const gitBranchSwitchResponse = z.object({
  type: z.literal('git_branch_switch_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitBranchSwitchResponse = z.infer<typeof gitBranchSwitchResponse>;

// ---- git_branch_merge ----

/** The plaintext a `git_branch_merge_request` envelope decrypts to — `name` is the branch merged INTO the session's current branch. */
export const gitBranchMergeRequestPayloadV1 = z.object({
  name: z.string().min(1),
});
export type GitBranchMergeRequestPayloadV1 = z.infer<typeof gitBranchMergeRequestPayloadV1>;

export function parseGitBranchMergeRequestPayloadV1(data: unknown): GitBranchMergeRequestPayloadV1 {
  return gitBranchMergeRequestPayloadV1.parse(data);
}

export function safeParseGitBranchMergeRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitBranchMergeRequestPayloadV1> {
  return gitBranchMergeRequestPayloadV1.safeParse(data);
}

export const gitBranchMergeRequest = z.object({
  type: z.literal('git_branch_merge_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitBranchMergeRequest = z.infer<typeof gitBranchMergeRequest>;

const gitBranchMergeResultV1 = z.object({
  outcome: z.literal('ok'),
  branch: z.string(),
  fastForward: z.boolean(),
});

/** A merge that stopped on real conflicts (SPEC §7.6/issue #234's own acceptance bar: a state the client can render and the user can resolve or abort) — `conflictedPaths` from `git diff --name-only --diff-filter=U`, never a swallowed nonzero exit. */
const gitBranchMergeConflictV1 = z.object({
  outcome: z.literal('conflict'),
  message: z.string(),
  conflictedPaths: z.array(z.string()),
});

/** The plaintext a `git_branch_merge_response` envelope decrypts to. */
export const gitBranchMergeResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitBranchMergeResultV1,
  gitBranchMergeConflictV1,
  gitBranchNotFoundV1,
  gitBranchErrorV1,
]);
export type GitBranchMergeResponsePayloadV1 = z.infer<typeof gitBranchMergeResponsePayloadV1>;

export function parseGitBranchMergeResponsePayloadV1(
  data: unknown,
): GitBranchMergeResponsePayloadV1 {
  return gitBranchMergeResponsePayloadV1.parse(data);
}

export function safeParseGitBranchMergeResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitBranchMergeResponsePayloadV1> {
  return gitBranchMergeResponsePayloadV1.safeParse(data);
}

export const gitBranchMergeResponse = z.object({
  type: z.literal('git_branch_merge_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitBranchMergeResponse = z.infer<typeof gitBranchMergeResponse>;

// ---- git_branch_merge_abort ----

/** A client asks the owning node to abort a merge stopped on conflicts — the other half of `git_branch_merge_response`'s `'conflict'` outcome's "resolve or abort". No envelope — nothing to carry beyond session/request id, same reasoning as `git_branch_list_request`. */
export const gitBranchMergeAbortRequest = z.object({
  type: z.literal('git_branch_merge_abort_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type GitBranchMergeAbortRequest = z.infer<typeof gitBranchMergeAbortRequest>;

const gitBranchMergeAbortResultV1 = z.object({
  outcome: z.literal('ok'),
});

/** The plaintext a `git_branch_merge_abort_response` envelope decrypts to. `'error'` covers "no merge in progress" as well as a genuine `git merge --abort` failure. */
export const gitBranchMergeAbortResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitBranchMergeAbortResultV1,
  gitBranchErrorV1,
]);
export type GitBranchMergeAbortResponsePayloadV1 = z.infer<
  typeof gitBranchMergeAbortResponsePayloadV1
>;

export function parseGitBranchMergeAbortResponsePayloadV1(
  data: unknown,
): GitBranchMergeAbortResponsePayloadV1 {
  return gitBranchMergeAbortResponsePayloadV1.parse(data);
}

export function safeParseGitBranchMergeAbortResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitBranchMergeAbortResponsePayloadV1> {
  return gitBranchMergeAbortResponsePayloadV1.safeParse(data);
}

export const gitBranchMergeAbortResponse = z.object({
  type: z.literal('git_branch_merge_abort_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitBranchMergeAbortResponse = z.infer<typeof gitBranchMergeAbortResponse>;
