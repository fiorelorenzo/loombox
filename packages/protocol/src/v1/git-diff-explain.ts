import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * AI diff-explain assist (SPEC §7.6; issue #236) — the working-tree diff
 * viewer's (#206) and hunk-level staging surface's (#232) own "explain"
 * action: a reviewer asks for a plain-language summary of either one
 * changed file's whole current diff or a single staged/unstaged hunk.
 * `git-commit.ts`'s (#233) sibling for UNDERSTANDING a diff rather than
 * drafting text FROM one — generated the exact same way: by prompting the
 * SESSION'S OWN live agent (`bridge.agentSession.prompt()`), never a new,
 * separately-configured provider call. See `@loombox/node`'s
 * `node-daemon.ts` `NodeDaemon.explainGitDiffForBridge`'s own doc comment
 * for why that half can't live here.
 *
 * One request/response pair, enveloped BOTH ways — unlike
 * `git_diff_request`/`git_hunk_diff_request`'s own envelope-less "asking
 * carries no content" shape: `scope` names a real path (and, for a hunk,
 * which side and index), genuine session content, mirroring
 * `git_hunk_action_request`'s identical reasoning for its own
 * `path`/`hunkIndex`. The reply carries the agent's own explanation text,
 * also real session content.
 *
 * Purely advisory: explaining a diff never stages, discards, or commits
 * anything, and never touches the worktree or the index — read-only, like
 * `git_diff_request`, just enveloped because (unlike that pair) the ASK
 * itself names real content.
 *
 * The diff/hunk text handed to the agent's prompt is bounded before it
 * ever reaches this wire pair — see `@loombox/node`'s `git-diff-explain.ts`
 * `MAX_EXPLAIN_DIFF_TEXT_CHARS` doc comment for why (an unbounded diff
 * both wastes tokens and can push a session toward the context ceiling
 * issue #250's own near-limit warning now makes visible).
 */

/** Which side of `git_hunk_diff_response`'s own per-file breakdown a `'hunk'` scope addresses — `git_hunk_action_request` gets this for free from its `action` (`stage`/`discard` imply `unstaged`, `unstage` implies `staged`); a read-only explain has no action to imply it, so this names it directly. */
export const gitDiffExplainHunkSideV1 = z.enum(['staged', 'unstaged']);
export type GitDiffExplainHunkSideV1 = z.infer<typeof gitDiffExplainHunkSideV1>;

/**
 * What to explain. A `'file'` scope explains every current hunk on both
 * sides of `path`, concatenated — the whole current diff, same file set
 * `git_diff_request`/`git_hunk_diff_request` already report. A `'hunk'`
 * scope explains exactly one hunk, addressed by `path`/`side`/`hunkIndex`
 * — `git_hunk_action_request`'s identical positional addressing, "valid
 * only against a diff computed fresh at explain time on the node" (that
 * pair's own doc comment); a caller re-issues this with a fresh
 * `requestId` after the worktree changes rather than trusting a stale
 * index from an earlier snapshot.
 */
export const gitDiffExplainScopeV1 = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal('hunk'),
    path: z.string().min(1),
    side: gitDiffExplainHunkSideV1,
    hunkIndex: z.number().int().nonnegative(),
  }),
]);
export type GitDiffExplainScopeV1 = z.infer<typeof gitDiffExplainScopeV1>;

/** The plaintext a `git_diff_explain_request` envelope decrypts to — `scope` is real session content, so this whole request travels sealed (see the file doc comment), unlike `git_diff_request`/`git_hunk_diff_request`'s own envelope-less "asking carries no content" shape. */
export const gitDiffExplainRequestPayloadV1 = z.object({
  scope: gitDiffExplainScopeV1,
});
export type GitDiffExplainRequestPayloadV1 = z.infer<typeof gitDiffExplainRequestPayloadV1>;

/** Parses and validates a decrypted `git_diff_explain_request` payload, throwing on an invalid one. */
export function parseGitDiffExplainRequestPayloadV1(data: unknown): GitDiffExplainRequestPayloadV1 {
  return gitDiffExplainRequestPayloadV1.parse(data);
}

/** Same as {@link parseGitDiffExplainRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseGitDiffExplainRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitDiffExplainRequestPayloadV1> {
  return gitDiffExplainRequestPayloadV1.safeParse(data);
}

/** The successful outcome: the agent's own plain-language explanation, verbatim — never itself applied to anything. */
const gitDiffExplainResultV1 = z.object({
  outcome: z.literal('ok'),
  explanation: z.string(),
});

/** A failed explain: no live agent for this session (archived, or `'disconnected'` since a restart — the same honest refusal `git_commit_draft_response`'s own error already covers, issue #233), the addressed path/hunk no longer exists in the current diff (the worktree changed since the caller's last `git_diff_request`/`git_hunk_diff_request`), or the agent's own reply came back empty. */
const gitDiffExplainErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string(),
});

/** The plaintext a `git_diff_explain_response` envelope decrypts to. */
export const gitDiffExplainResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitDiffExplainResultV1,
  gitDiffExplainErrorV1,
]);
export type GitDiffExplainResponsePayloadV1 = z.infer<typeof gitDiffExplainResponsePayloadV1>;

/** Parses and validates a decrypted `git_diff_explain_response` payload, throwing on an invalid one. */
export function parseGitDiffExplainResponsePayloadV1(
  data: unknown,
): GitDiffExplainResponsePayloadV1 {
  return gitDiffExplainResponsePayloadV1.parse(data);
}

/** Same as {@link parseGitDiffExplainResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseGitDiffExplainResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitDiffExplainResponsePayloadV1> {
  return gitDiffExplainResponsePayloadV1.safeParse(data);
}

/** A client asks the owning node to explain `scope`'s diff (SPEC §7.6; issue #236). Enveloped — see the file doc comment. Fresh every call, like `git_hunk_action_request`; there is no persistent subscription, and a caller re-issues this (a fresh `requestId`) to regenerate after further changes. */
export const gitDiffExplainRequest = z.object({
  type: z.literal('git_diff_explain_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitDiffExplainRequest = z.infer<typeof gitDiffExplainRequest>;

/** The owning node's reply. Fanned out to a session's subscribed clients exactly like `git_hunk_action_response` — a requesting client filters on `requestId`; any other subscribed client simply has no pending request with that id. */
export const gitDiffExplainResponse = z.object({
  type: z.literal('git_diff_explain_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitDiffExplainResponse = z.infer<typeof gitDiffExplainResponse>;
