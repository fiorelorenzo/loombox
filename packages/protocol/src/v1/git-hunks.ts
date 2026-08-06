import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { gitDiffFileStatusV1 } from './git-diff';
import { PROTOCOL_V1 } from './handshake';

/**
 * Hunk-level stage/unstage/discard (SPEC §7.6; issue #232) — a session's
 * staged-vs-unstaged worktree state broken down per hunk, as opposed to
 * `git-diff.ts`'s `git_diff_request`/`git_diff_response` pair (issue
 * #206), which reports one combined `HEAD`-vs-worktree text per file with
 * no notion of the index at all. Reuses that pair's own `WorktreeDiffViewer`
 * tab (issue #737's tab strip) as a second display mode rather than a
 * second diff surface — see that component's own file doc comment.
 *
 * Two message pairs:
 * - `git_hunk_diff_request`/`git_hunk_diff_response`: read-only, shaped
 *   like `git_diff_request`/`git_diff_response` (no envelope on the
 *   request — asking carries no content, same reasoning). The reply
 *   carries every changed file's hunks split into `staged` (`HEAD` vs
 *   index) and `unstaged` (index vs worktree) — a file with a partially
 *   staged edit appears once with hunks in both arrays.
 * - `git_hunk_action_request`/`git_hunk_action_response`: a client asking
 *   the owning node to stage/unstage/discard exactly one hunk. Enveloped
 *   (unlike the diff request): `path` is real session content, mirroring
 *   `fs_read_request`'s own enveloped `path`. `hunkIndex` addresses a hunk
 *   positionally within whichever side `action` implies (`stage`/`discard`
 *   read `unstaged[hunkIndex]`, `unstage` reads `staged[hunkIndex]`) —
 *   valid only against a diff computed fresh at action time on the node
 *   (never trusting patch text a client might send), so a caller re-issues
 *   `git_hunk_diff_request` after every action rather than reusing stale
 *   indices from an earlier snapshot.
 *
 * Runs real `git` subcommands through `ExecutionTarget.exec` exactly like
 * `git-diff.ts` (`packages/node/src/git-diff.ts`'s `computeHunkDiff`/
 * `applyGitHunkAction`) — works identically for a `local` or an `ssh:`
 * target, this pair's own acceptance line (issue #232).
 */

export const gitHunkLineKindV1 = z.enum(['context', 'added', 'removed']);
export type GitHunkLineKindV1 = z.infer<typeof gitHunkLineKindV1>;

/** One line inside a hunk, already stripped of its leading `' '`/`+`/`-` marker — `WorktreeDiffViewer`'s staging mode renders these with `DiffViewer`'s own `.diff-lines li.<kind>` convention. */
export const gitHunkLineV1 = z.object({
  kind: gitHunkLineKindV1,
  text: z.string(),
});
export type GitHunkLineV1 = z.infer<typeof gitHunkLineV1>;

/** One unified-diff hunk. `header` is the full `@@ -a,b +c,d @@ <context>` line verbatim (trailing function-context text and all) — rendered as-is above `lines`, never reparsed client-side. */
export const gitHunkV1 = z.object({
  header: z.string(),
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(gitHunkLineV1),
});
export type GitHunkV1 = z.infer<typeof gitHunkV1>;

/** One changed file's hunks, split by side. `staged`/`unstaged` are independently indexable — `git_hunk_action_request.hunkIndex` addresses one of these two arrays, never a combined list. Either array (never both) is empty for a file that's entirely staged or entirely unstaged; a genuinely untracked file (`git status`'s `??`) reports its whole content as one single `unstaged` hunk with `oldStart: 0, oldLines: 0`, `staged: []`. */
export const gitHunkFileV1 = z.object({
  path: z.string().min(1),
  /** The rename source path, only when `status === 'renamed'`; `null` otherwise — mirrors `GitDiffFileV1.previousPath`. */
  previousPath: z.string().min(1).nullable(),
  status: gitDiffFileStatusV1,
  staged: z.array(gitHunkV1),
  unstaged: z.array(gitHunkV1),
});
export type GitHunkFileV1 = z.infer<typeof gitHunkFileV1>;

/** A client asks the owning node for one session's current staged/unstaged hunk breakdown. No envelope — see the file doc comment. Fresh every call, like `git_diff_request`; there is no persistent subscription. */
export const gitHunkDiffRequest = z.object({
  type: z.literal('git_hunk_diff_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type GitHunkDiffRequest = z.infer<typeof gitHunkDiffRequest>;

/** The successful outcome: every changed file's hunks. `[]` for a clean worktree — never an error. */
const gitHunkDiffResultV1 = z.object({
  outcome: z.literal('ok'),
  files: z.array(gitHunkFileV1),
});

/** A failed diff (no `git` on the target, the worktree isn't a git repository, or the underlying command failed for some other reason) — same shape as `GitDiffResponsePayloadV1`'s own error member. */
const gitHunkDiffErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string(),
});

/** The plaintext a `git_hunk_diff_response` envelope decrypts to. */
export const gitHunkDiffResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitHunkDiffResultV1,
  gitHunkDiffErrorV1,
]);
export type GitHunkDiffResponsePayloadV1 = z.infer<typeof gitHunkDiffResponsePayloadV1>;

/** Parses and validates a decrypted `git_hunk_diff_response` payload, throwing on an invalid one. */
export function parseGitHunkDiffResponsePayloadV1(data: unknown): GitHunkDiffResponsePayloadV1 {
  return gitHunkDiffResponsePayloadV1.parse(data);
}

/** Same as {@link parseGitHunkDiffResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseGitHunkDiffResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitHunkDiffResponsePayloadV1> {
  return gitHunkDiffResponsePayloadV1.safeParse(data);
}

/** The owning node's reply. Fanned out to a session's subscribed clients exactly like `git_diff_response` — a requesting client filters on `requestId`. */
export const gitHunkDiffResponse = z.object({
  type: z.literal('git_hunk_diff_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitHunkDiffResponse = z.infer<typeof gitHunkDiffResponse>;

export const gitHunkActionV1 = z.enum(['stage', 'unstage', 'discard']);
export type GitHunkActionV1 = z.infer<typeof gitHunkActionV1>;

/** The plaintext a `git_hunk_action_request` envelope decrypts to — `path` is real session content, so this whole request travels sealed (see the file doc comment), unlike `git_hunk_diff_request`/`git_diff_request`'s own envelope-less "asking carries no content" shape. */
export const gitHunkActionRequestPayloadV1 = z.object({
  path: z.string().min(1),
  hunkIndex: z.number().int().nonnegative(),
  action: gitHunkActionV1,
});
export type GitHunkActionRequestPayloadV1 = z.infer<typeof gitHunkActionRequestPayloadV1>;

/** Parses and validates a decrypted `git_hunk_action_request` payload, throwing on an invalid one. */
export function parseGitHunkActionRequestPayloadV1(data: unknown): GitHunkActionRequestPayloadV1 {
  return gitHunkActionRequestPayloadV1.parse(data);
}

/** Same as {@link parseGitHunkActionRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseGitHunkActionRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitHunkActionRequestPayloadV1> {
  return gitHunkActionRequestPayloadV1.safeParse(data);
}

/** A client asks the owning node to stage/unstage/discard exactly one hunk. Routed to the owning node exactly like `git_diff_request`; the relay only ever sees `sessionId`/`requestId` plus this opaque `EncryptedEnvelope` — the path being touched, which hunk, and whether it was staged, unstaged, or discarded never reach the relay in the clear (SPEC §8's metadata boundary). */
export const gitHunkActionRequest = z.object({
  type: z.literal('git_hunk_action_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitHunkActionRequest = z.infer<typeof gitHunkActionRequest>;

/** The successful outcome: the action applied cleanly. Carries no updated diff of its own — a caller re-issues `git_hunk_diff_request` to see the result, same "re-request to refresh" contract `git_diff_request` already documents. */
const gitHunkActionResultV1 = z.object({
  outcome: z.literal('ok'),
});

/** A failed action: `hunkIndex` no longer names a real hunk on that side (the worktree changed since the caller's last `git_hunk_diff_request`), an unstage/discard attempted on a side that has none, or the underlying `git apply`/`git add`/`git clean` command failed. */
const gitHunkActionErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string(),
});

/** The plaintext a `git_hunk_action_response` envelope decrypts to. */
export const gitHunkActionResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitHunkActionResultV1,
  gitHunkActionErrorV1,
]);
export type GitHunkActionResponsePayloadV1 = z.infer<typeof gitHunkActionResponsePayloadV1>;

/** Parses and validates a decrypted `git_hunk_action_response` payload, throwing on an invalid one. */
export function parseGitHunkActionResponsePayloadV1(data: unknown): GitHunkActionResponsePayloadV1 {
  return gitHunkActionResponsePayloadV1.parse(data);
}

/** Same as {@link parseGitHunkActionResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseGitHunkActionResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitHunkActionResponsePayloadV1> {
  return gitHunkActionResponsePayloadV1.safeParse(data);
}

/** The owning node's reply. Fanned out to a session's subscribed clients exactly like `git_hunk_diff_response` above. */
export const gitHunkActionResponse = z.object({
  type: z.literal('git_hunk_action_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitHunkActionResponse = z.infer<typeof gitHunkActionResponse>;
