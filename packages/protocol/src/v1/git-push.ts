import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Pushing a session's own branch to its remote (SPEC §7.6/§7.14; issue
 * #235) — the last step of the create/switch/merge/stash/commit chain
 * `git-branch.ts`/`git-stash.ts`/`git-commit.ts` (issues #234/#232/#233)
 * already cover, and the FIRST one that talks to a remote at all.
 *
 * One message pair, enveloped (a `force` choice is real session content,
 * mirrors `git_hunk_action_request`'s enveloped payload):
 * `git_push_request`/`_response`. There is no separate "preview" request
 * like `pr_open_preview_request` — a push has no `gh`-side lookup to do
 * first (no default branch, no commit-count check), so the request IS
 * the whole operation, same shape as `git_branch_switch_request`.
 *
 * **Which branch, to which remote.** Always the session's own branch
 * (`resolveSessionBranch`, `node/src/session-branch.ts`) to `origin` —
 * identical scope to `pr-open.ts`'s `openPr`, which already pushes that
 * exact pair. No branch/remote name travels on the wire; there is
 * nothing to choose, only whether to `force`.
 *
 * **Credentials.** Deliberately the same seam `pr-open.ts`'s own file
 * doc comment already justifies at length: every `git push` below runs
 * through the session's `ExecutionTarget`, authenticated by whatever
 * that target's own operator already has working there (an SSH agent, a
 * git credential helper, `gh`'s own credential helper) — never a second,
 * relay-mediated credential path. This is also SPEC §8's SSH-credential
 * rule in the shape issue #235 names directly: "using the node's own
 * credentials (never the relay/client)". Only `git`'s own stdout/stderr
 * (branch names, a rejection reason — never a secret) ever crosses back
 * through the relay to a client.
 *
 * **Five outcomes, not one generic failure (issue #235's own acceptance
 * bar: "a clear, actionable error rather than a silent no-op").** A
 * plain push is the first operation in this whole feature area that can
 * fail for reasons entirely outside this repository's own state:
 * - `'ok'`: pushed. `setUpstream: true` the first time this branch is
 *   ever pushed (git-diff.ts's `pushBranch` always passes
 *   `--set-upstream`, so this is also how "first push of a new branch"
 *   from issue #235's original acceptance bar is satisfied — silently
 *   and unconditionally, never a separate step a client has to drive).
 * - `'no_branch'`: a detached `HEAD` (or a non-git worktree) has no
 *   named branch to push at all — `previewPrOpen`'s identical
 *   `'no_branch'` category, same reasoning.
 * - `'rejected_non_fast_forward'`: the remote has commits this branch
 *   doesn't — real `git push`'s own `[rejected] ... (fetch first)`/
 *   `(non-fast-forward)` outcome, never swallowed. The way forward:
 *   fetch and merge/rebase, or retry with `force: true`.
 * - `'rejected_stale_lease'`: `force: true` only ever uses
 *   `--force-with-lease`, never plain `--force` (`git-diff.ts`'s
 *   `pushBranch` doc comment has the full reasoning) — this is that
 *   safety catching something: this worktree's own knowledge of the
 *   remote ref is out of date, so blindly forcing over it could
 *   silently discard a commit this worktree never even saw. The way
 *   forward: fetch (which re-syncs the lease), then retry.
 * - `'auth_failed'`: the remote refused the connection or the
 *   credentials themselves (SSH `Permission denied`, HTTPS `could not
 *   read Username`/`Authentication failed`, or GitHub's own
 *   indistinguishable-from-missing `Repository not found` for a private
 *   repo this credential can't see) — distinguished from a generic
 *   `'error'` because "check your access" is a concrete, different next
 *   step than "check your history".
 * - `'error'`: any other push failure (no `origin` remote configured,
 *   `git` missing from the target's `PATH`, ...).
 */

// ---- git_push ----

/** The plaintext a `git_push_request` envelope decrypts to. */
export const gitPushRequestPayloadV1 = z.object({
  /** `--force-with-lease` when true (never plain `--force` — see this file's own doc comment) — a caller retrying after a `'rejected_non_fast_forward'`/`'rejected_stale_lease'` outcome sets this explicitly; it is never implied by anything server-side. */
  force: z.boolean(),
});
export type GitPushRequestPayloadV1 = z.infer<typeof gitPushRequestPayloadV1>;

export function parseGitPushRequestPayloadV1(data: unknown): GitPushRequestPayloadV1 {
  return gitPushRequestPayloadV1.parse(data);
}

export function safeParseGitPushRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitPushRequestPayloadV1> {
  return gitPushRequestPayloadV1.safeParse(data);
}

export const gitPushRequest = z.object({
  type: z.literal('git_push_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitPushRequest = z.infer<typeof gitPushRequest>;

const gitPushResultV1 = z.object({
  outcome: z.literal('ok'),
  branch: z.string().min(1),
  setUpstream: z.boolean(),
  forced: z.boolean(),
});

const gitPushNoBranchV1 = z.object({
  outcome: z.literal('no_branch'),
  message: z.string(),
});

const gitPushRejectedNonFastForwardV1 = z.object({
  outcome: z.literal('rejected_non_fast_forward'),
  message: z.string(),
});

const gitPushRejectedStaleLeaseV1 = z.object({
  outcome: z.literal('rejected_stale_lease'),
  message: z.string(),
});

const gitPushAuthFailedV1 = z.object({
  outcome: z.literal('auth_failed'),
  message: z.string(),
});

const gitPushErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string(),
});

/** The plaintext a `git_push_response` envelope decrypts to. */
export const gitPushResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitPushResultV1,
  gitPushNoBranchV1,
  gitPushRejectedNonFastForwardV1,
  gitPushRejectedStaleLeaseV1,
  gitPushAuthFailedV1,
  gitPushErrorV1,
]);
export type GitPushResponsePayloadV1 = z.infer<typeof gitPushResponsePayloadV1>;

/** Parses and validates a decrypted `git_push_response` payload, throwing on an invalid one. */
export function parseGitPushResponsePayloadV1(data: unknown): GitPushResponsePayloadV1 {
  return gitPushResponsePayloadV1.parse(data);
}

/** Same as {@link parseGitPushResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseGitPushResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitPushResponsePayloadV1> {
  return gitPushResponsePayloadV1.safeParse(data);
}

export const gitPushResponse = z.object({
  type: z.literal('git_push_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitPushResponse = z.infer<typeof gitPushResponse>;
