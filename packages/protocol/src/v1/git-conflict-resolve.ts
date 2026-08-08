import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * AI merge-conflict resolution assist (SPEC §7.6; issue #237) —
 * `git-diff-explain.ts`'s (#236) own sibling: the same "one agent turn,
 * wired through the node" shape, applied to a conflicted file's markers
 * instead of a diff hunk. Reuses two other landed pieces rather than
 * reinventing them:
 * - The integrated editor's `fs_write_request`/`fs_write_response` pair
 *   (issue #205, `fs.ts`) is how a proposal actually lands on disk. This
 *   file's own response carries `baseHash` — the resolved file's exact
 *   pre-resolution hash — so a client applies a proposal by calling
 *   `fs_write_request` with that `baseHash`, never a bespoke "apply" wire
 *   message of its own. That gets issue #260's optimistic-concurrency
 *   contract for free: a file edited (by a human, another device, or the
 *   session's own agent) between the proposal landing and the user
 *   clicking "Apply" comes back `outcome: 'conflict'` from the write
 *   itself, exactly like every other conflict-safe save in this codebase
 *   — never a silent clobber of whatever changed underneath.
 * - Declining is simply never calling `fs_write_request` at all — this
 *   pair's own request is read-only (it parses and prompts, it never
 *   writes), so a client that shows the proposal and closes the dialog
 *   leaves the file exactly as it was, no undo needed.
 *
 * The design question that decides whether this is useful or dangerous
 * (Lorenzo's own framing): a proposal must be reviewable before it is
 * applied, and it must be obvious which side each decision came from. An
 * AI resolution that silently picks a side is worse than the raw conflict
 * markers, because the markers at least tell you a choice was made. This
 * file answers that by NEVER trusting the agent's own self-report of
 * which side it kept — `origin` on each `GitConflictResolutionHunkV1` is
 * computed by the node comparing the agent's literal reply text against
 * the hunk's real `oursText`/`theirsText` (`packages/node/src/
 * git-conflict-resolve.ts`'s `resolveHunkOrigin`): an exact match to one
 * side reports `'ours'`/`'theirs'`, anything else — a genuine merge of
 * both, or a fresh rewrite — reports `'rewritten'`. A derived fact, not a
 * self-attested label.
 *
 * Cost is bounded up front rather than truncated silently (issue #250's
 * context-limit warning exists because this codebase already hit
 * "a large prompt is a real cost", and a large CONFLICTED file is a
 * multi-turn prompt here, one agent turn per conflicted hunk — unlike
 * `git_diff_explain_request`'s always-exactly-one-turn shape): a file
 * with more conflicted hunks than
 * `packages/node/src/git-conflict-resolve.ts`'s own
 * `MAX_CONFLICT_HUNKS_PER_RESOLVE` refuses outright with `outcome:
 * 'too_large'`, carrying the real count so a client can say why, rather
 * than spending an unbounded number of turns from one click.
 *
 * One message pair, scoped like `git_diff_explain_request`/`_response`
 * (an agent-turn-spending read, enveloped because `path` is real session
 * content, session-scoped by `sessionId` alone — no `targetId`, the
 * owning node already knows its own target):
 * - `git_conflict_resolve_request`/`_response`: proposes a resolution for
 *   EVERY conflicted hunk `path` currently has, never applying anything.
 *   `'ok'` carries the raw hunks (for rendering "alongside the raw
 *   conflict markers", issue #237's own acceptance line), the per-hunk
 *   resolution with its derived `origin`, and `resolvedContent` — the
 *   whole file with each conflict block replaced by its resolution,
 *   ready to review, hand-edit, and apply via `fs_write_request` as one
 *   deliberate action. `'too_large'` and `'error'` (no live agent, `path`
 *   has no conflict markers at all, or the agent's reply for some hunk
 *   came back empty) are both honest, actionable non-`'ok'` outcomes,
 *   never a swallowed exception.
 */

/** How a hunk's `resolvedText` relates to its two real sides (see the file doc comment: derived by the node, never self-reported by the agent) — `'rewritten'` covers both "combined both sides" and "wrote something new", since either way it is NOT a silent pick of one side, which is the actual safety property this exists to surface. */
export const gitConflictHunkOriginV1 = z.enum(['ours', 'theirs', 'rewritten']);
export type GitConflictHunkOriginV1 = z.infer<typeof gitConflictHunkOriginV1>;

/** One conflict region parsed straight out of a file's real `<<<<<<<`/`=======`/`>>>>>>>` markers (optionally diff3-style `|||||||` base text too) — `index` is this hunk's position among every conflict in the file, addressed the same positional way `GitHunkV1`/`git_hunk_action_request` already address a staged/unstaged hunk. `oursText`/`theirsText` are the literal lines between the markers, trailing newline included, never trimmed — replacing a hunk's markers with its own `oursText` verbatim reproduces exactly what `git checkout --ours` would leave for that hunk alone. */
export const gitConflictHunkV1 = z.object({
  index: z.number().int().nonnegative(),
  oursLabel: z.string(),
  theirsLabel: z.string(),
  oursText: z.string(),
  theirsText: z.string(),
  baseText: z.string().nullable(),
});
export type GitConflictHunkV1 = z.infer<typeof gitConflictHunkV1>;

/** The agent's proposed replacement for one `GitConflictHunkV1`, plus the origin the node derived for it (see the file doc comment). `resolvedText` is the agent's real reply, trimmed — never itself written anywhere; a client assembles/edits `GitConflictResolveResultV1.resolvedContent` and applies THAT via `fs_write_request`. */
export const gitConflictResolutionHunkV1 = z.object({
  index: z.number().int().nonnegative(),
  origin: gitConflictHunkOriginV1,
  resolvedText: z.string(),
});
export type GitConflictResolutionHunkV1 = z.infer<typeof gitConflictResolutionHunkV1>;

/** The plaintext a `git_conflict_resolve_request` envelope decrypts to — `path` is real session content, so this whole request travels sealed (see the file doc comment), unlike `git_branch_merge_abort_request`'s own envelope-less "asking carries no content" shape. */
export const gitConflictResolveRequestPayloadV1 = z.object({
  path: z.string().min(1),
});
export type GitConflictResolveRequestPayloadV1 = z.infer<typeof gitConflictResolveRequestPayloadV1>;

/** Parses and validates a decrypted `git_conflict_resolve_request` payload, throwing on an invalid one. */
export function parseGitConflictResolveRequestPayloadV1(
  data: unknown,
): GitConflictResolveRequestPayloadV1 {
  return gitConflictResolveRequestPayloadV1.parse(data);
}

/** Same as {@link parseGitConflictResolveRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseGitConflictResolveRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitConflictResolveRequestPayloadV1> {
  return gitConflictResolveRequestPayloadV1.safeParse(data);
}

/** The successful outcome: `path`'s real conflict hunks, the agent's per-hunk resolution, and the assembled whole-file `resolvedContent` — reviewable, editable, and appliable via `fs_write_request` with `baseHash`. Never itself applied to anything (see the file doc comment). */
const gitConflictResolveResultV1 = z.object({
  outcome: z.literal('ok'),
  path: z.string(),
  baseHash: z.string().min(1),
  hunks: z.array(gitConflictHunkV1),
  resolution: z.array(gitConflictResolutionHunkV1),
  resolvedContent: z.string(),
});

/** Refused before spending a single agent turn: `path` has more conflicted hunks than this node's own bound for one AI resolve (see the file doc comment's cost-realism note). `hunkCount`/`maxHunks` let a client say exactly why, rather than a generic refusal. */
const gitConflictResolveTooLargeV1 = z.object({
  outcome: z.literal('too_large'),
  path: z.string(),
  message: z.string(),
  hunkCount: z.number().int().nonnegative(),
  maxHunks: z.number().int().positive(),
});

/** A failed resolve: no live agent for this session (archived, or `'disconnected'` since a restart — the same honest refusal `git_diff_explain_response`'s own error already covers), `path` has no conflict markers at all (nothing to resolve), or some hunk's agent reply came back empty. */
const gitConflictResolveErrorV1 = z.object({
  outcome: z.literal('error'),
  path: z.string(),
  message: z.string(),
});

/** The plaintext a `git_conflict_resolve_response` envelope decrypts to. */
export const gitConflictResolveResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitConflictResolveResultV1,
  gitConflictResolveTooLargeV1,
  gitConflictResolveErrorV1,
]);
export type GitConflictResolveResponsePayloadV1 = z.infer<
  typeof gitConflictResolveResponsePayloadV1
>;

/** Parses and validates a decrypted `git_conflict_resolve_response` payload, throwing on an invalid one. */
export function parseGitConflictResolveResponsePayloadV1(
  data: unknown,
): GitConflictResolveResponsePayloadV1 {
  return gitConflictResolveResponsePayloadV1.parse(data);
}

/** Same as {@link parseGitConflictResolveResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseGitConflictResolveResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitConflictResolveResponsePayloadV1> {
  return gitConflictResolveResponsePayloadV1.safeParse(data);
}

/** A client asks the owning node to propose a resolution for every conflicted hunk in `path` (SPEC §7.6; issue #237). Enveloped — see the file doc comment. Fresh every call, like `git_diff_explain_request`; there is no persistent subscription, and a caller re-issues this (a fresh `requestId`) to regenerate after further changes (e.g. after a `fs_write_request` `'conflict'` reload). */
export const gitConflictResolveRequest = z.object({
  type: z.literal('git_conflict_resolve_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitConflictResolveRequest = z.infer<typeof gitConflictResolveRequest>;

/** The owning node's reply. Fanned out to a session's subscribed clients exactly like `git_diff_explain_response` — a requesting client filters on `requestId`; any other subscribed client simply has no pending request with that id. */
export const gitConflictResolveResponse = z.object({
  type: z.literal('git_conflict_resolve_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitConflictResolveResponse = z.infer<typeof gitConflictResolveResponse>;
