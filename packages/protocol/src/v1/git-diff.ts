import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * The working-tree diff viewer's own wire pair (SPEC §7.4 "inline/split
 * diff viewer for reviewing agent changes... the same component as the
 * tool-call diff", issue #206) — what has actually changed in a session's
 * worktree right now (staged + unstaged + untracked, all compared against
 * `HEAD`), as opposed to `DiffViewer.svelte`'s existing per-tool-call ACP
 * `Diff` (SPEC §7.24), which only ever reflects what one completed tool
 * call reported and says nothing about the worktree's live state.
 *
 * One request/reply pair, shaped like `fs_read_request`/`fs_read_response`
 * (issue #737) — routed to the owning node by `sessionId`, over
 * `ExecutionTarget.exec` running real `git` subcommands. Issue #238's
 * `pr-open.ts` already established `target.exec('git', ['-C', worktreePath,
 * ...])` as this codebase's way to run git against either a `local` or an
 * `ssh:` target through the one shared `ExecutionTarget` seam; deliberately
 * NOT `GitCheckpointStore`'s own shape (issue #603's other candidate) —
 * that store spawns `git` as a LOCAL child process by its own module doc
 * comment and refuses an `ssh:` session outright (`unsupported_target`),
 * which this viewer's own acceptance line ("works for a project on either
 * a `local` or an `ssh:` target") rules out.
 *
 * No envelope on `git_diff_request` itself, unlike `fs_read_request`'s own
 * `path` (a caller-chosen filter): asking for "the whole worktree's own
 * diff right now" carries no content of its own to encrypt — the same
 * "asking carries no content" reasoning `checkpoint_list` already uses.
 *
 * `git_diff_response`'s payload carries every changed file in `DiffViewer`'s
 * own ACP-`Diff` shape (`oldText`/`newText`) so the client hands each file
 * straight to the exact same component the tool-call diff card already
 * mounts — never a second diff renderer. `oldText: null` means "no previous
 * content" (a new/untracked file); a binary/symlink change collapses to
 * `oldText: null, newText: ''` regardless of its real `status`, `DiffViewer`'s
 * existing structural-only fallback, reused as-is rather than inventing a
 * second "this is binary" rendering. `status`/`previousPath` are this pair's
 * own addition on top of ACP's `Diff` shape — a rename's own "renamed from"
 * annotation lives in the caller (`WorktreeDiffViewer.svelte`), never inside
 * `DiffViewer` itself, which takes no status prop.
 */

export const gitDiffFileStatusV1 = z.enum(['added', 'modified', 'deleted', 'renamed']);
export type GitDiffFileStatusV1 = z.infer<typeof gitDiffFileStatusV1>;

/** One changed file's diff, in `DiffViewer`'s own `{path, oldText, newText}` shape plus this pair's own `status`/`previousPath`. */
export const gitDiffFileV1 = z.object({
  path: z.string().min(1),
  /** The rename source path, only when `status === 'renamed'`; `null` otherwise. */
  previousPath: z.string().min(1).nullable(),
  status: gitDiffFileStatusV1,
  oldText: z.string().nullable(),
  newText: z.string(),
});
export type GitDiffFileV1 = z.infer<typeof gitDiffFileV1>;

/**
 * A client asks the owning node for one session's current working-tree
 * diff. No envelope — see the file doc comment. Fresh every call (like
 * `fs_read_request`'s own `readFile`): there is no persistent subscription,
 * a caller re-sends (a fresh `requestId`) to refresh.
 */
export const gitDiffRequest = z.object({
  type: z.literal('git_diff_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type GitDiffRequest = z.infer<typeof gitDiffRequest>;

/** The successful outcome: every changed file, in no particular guaranteed order beyond whatever `git status` itself reports. Empty for a clean worktree — never an error. */
const gitDiffResultV1 = z.object({
  outcome: z.literal('ok'),
  files: z.array(gitDiffFileV1),
});

/** A failed diff (no `git` on the target, the worktree isn't a git repository, or the underlying command failed for some other reason). */
const gitDiffErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string(),
});

/** The plaintext a `git_diff_response` envelope decrypts to. */
export const gitDiffResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitDiffResultV1,
  gitDiffErrorV1,
]);
export type GitDiffResponsePayloadV1 = z.infer<typeof gitDiffResponsePayloadV1>;

/** Parses and validates a decrypted `git_diff_response` payload, throwing on an invalid one. */
export function parseGitDiffResponsePayloadV1(data: unknown): GitDiffResponsePayloadV1 {
  return gitDiffResponsePayloadV1.parse(data);
}

/** Same as {@link parseGitDiffResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseGitDiffResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitDiffResponsePayloadV1> {
  return gitDiffResponsePayloadV1.safeParse(data);
}

/**
 * The owning node's reply. Fanned out to a session's subscribed clients
 * exactly like `fs_read_response` — a requesting client filters on
 * `requestId` to match its own pending request; any other subscribed
 * client simply has no pending request with that id.
 */
export const gitDiffResponse = z.object({
  type: z.literal('git_diff_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitDiffResponse = z.infer<typeof gitDiffResponse>;
