import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Wire surface for `@loombox/supervisor`'s `GitCheckpointStore` (SPEC
 * §7.20; issue #266's engine, issue #603's wiring) — the part #266
 * deliberately left out: nothing that lets a client trigger a checkpoint
 * or a rollback. `@loombox/node`'s `NodeDaemon` owns this wiring (not
 * `@loombox/supervisor`, despite issue #603's own "likely" guess) because
 * a checkpoint is namespaced by loombox's own routing `sessionId`
 * (`GitCheckpointStoreOptions.sessionId`'s own doc comment: "so two
 * sessions sharing a project ... never collide"), and that id is only
 * ever known to `@loombox/node` — `AgentSession`/`AgentSupervisor` only
 * ever see the ACP protocol's OWN session id (`bridge.agentSession.id`),
 * a distinct value `NodeDaemon` is already careful never to confuse with
 * `bridge.session.id` (see e.g. `wireAgentSession`'s config-option
 * listener). Every message below is addressed by that same routing
 * `sessionId`, resolved to a `projectPath`/`worktreePath` node-side exactly
 * like `test-runner-config.ts`'s own doc comment already documents.
 *
 * Four request/reply pairs, all routed to the owning node exactly like
 * `test_runner_config_get`/`_set`/`_detect` (`relay.ts`'s
 * `routeToOwningNode`/`fanOutDirect`) — genuinely four different shapes
 * (one new checkpoint / the whole list / a dry-run preview / an actual
 * destructive restore), so each gets its own reply type rather than
 * reusing one, the same reasoning `test_runner_config_detect` already
 * used to justify its own `_detected` reply instead of reusing
 * `_result`:
 * - `checkpoint_create` / `checkpoint_result` — take a checkpoint of the
 *   worktree's current state right now, with an optional caller-supplied
 *   label (issue #268's "named or auto-labeled checkpoint on demand").
 *   Enveloped: a label is free text a user or agent chose, the same
 *   "project-private content" reasoning `test_runner_config_set` already
 *   applies to a command string.
 * - `checkpoint_list` / `checkpoint_list_result` — every checkpoint taken
 *   for this session so far, oldest first, mirroring
 *   `GitCheckpointStore.listCheckpoints()`'s own contract (empty array
 *   for "none yet", never an error). No envelope on the request: asking
 *   carries no content, same reasoning as `test_runner_config_get`.
 * - `checkpoint_restore_preview` / `checkpoint_restore_preview_result` —
 *   what a restore to `checkpointId` would do, with NO side effects
 *   (`GitCheckpointStore.previewRestore()`): commits since the checkpoint
 *   that stay untouched, and whether anything uncommitted would be
 *   discarded. `checkpointId` travels as a plain field, not enveloped —
 *   "only the id of what to act on", the same shape `terminal_close`'s
 *   `terminalId` already uses. This is issue #603's own "surface
 *   `RestorePreview` to the client before a rollback executes" — the
 *   confirmation UI (#268) calls this to render its dialog; the seam
 *   #268 still has to build is the dialog itself.
 * - `checkpoint_restore` / `checkpoint_restore_result` — actually roll
 *   back to `checkpointId`, discarding everything since. `confirm` is a
 *   REQUIRED, no-default boolean the caller must set explicitly once it
 *   has shown the human `checkpoint_restore_preview`'s own
 *   `hasUncommittedChangesToDiscard`; sending `confirm: false` (or
 *   omitting it entirely — this field is not optional) when there is
 *   something to discard gets `outcome: 'confirmation_required'` back
 *   instead of an actual restore, carrying the same preview shape so a
 *   caller that skipped the separate preview call still gets exactly the
 *   information it needs to ask the human. This is the wire-level half of
 *   issue #603's "a rollback that would discard uncommitted human edits
 *   must say so before it runs" — enforced structurally by this node,
 *   never left to a client's own good behavior. `outcome: 'ok'` carries
 *   `GitCheckpointStore.restore()`'s own `RestoreResult` — issue #603's
 *   "the node must report what it actually did" — and `outcome: 'error'`
 *   reports one of {@link checkpointErrorTypeV1}'s named reasons a
 *   checkpoint operation can fail for.
 *
 * Every `*_result` payload below is `{ outcome: 'ok', ... } |
 * { outcome: 'error', errorType, message }` (`checkpoint_restore_result`
 * adds a third `'confirmation_required'` member) — the same
 * discriminated-outcome shape `account-connect.ts`'s
 * `accountPinResolveOutcome` already established for "this can fail for
 * one of several named, structural reasons", reused here rather than the
 * `{outcome:'error', message}`-only shape `agent-profile.ts`'s
 * `agentProfileSessionErrorPayloadV1` uses, since a client actually needs
 * to distinguish *which* reason (e.g. render "confirm rollback" for
 * `checkpoint_not_found` very differently from `dirty_submodule`) rather
 * than only a free-text message.
 *
 * `isWorkInPlace` (on {@link gitCheckpointV1} and {@link restorePreviewV1})
 * is this wiring's own answer to issue #603's "worktree-isolated and
 * in-place sessions behave differently here": both kinds of `local`
 * session get full checkpoint/restore support (the engine is agnostic —
 * it only ever sees a `worktreePath`), but a `workInPlace` session's
 * worktree *is* the user's actual project folder (`Session`'s own doc
 * comment, `@loombox/node`'s `session-manager.ts`), so any uncommitted
 * change `previewRestore()` reports there may be the human's own
 * in-progress edit, not just the agent's — the engine's git-status check
 * cannot tell the two apart in either kind of session, so this flag is
 * carried across the wire precisely so the confirmation UI (#268) can
 * render the sharper warning a `workInPlace` session's own uncommitted
 * state deserves, rather than guessing from `sessionId` alone. Derived
 * node-side from `Session.branch === ''` (the same test the `Session`
 * doc comment itself uses to mean "no isolated worktree").
 *
 * An `ssh:`-target session gets neither: `GitCheckpointStore` spawns
 * `git` as a LOCAL child process (its own module doc comment), so an
 * `ssh:` session's `worktreePath` — a path on the remote host — is not
 * reachable from this node at all. Every request below answers
 * `errorType: 'unsupported_target'` for one rather than trying and
 * failing confusingly against an unrelated (or absent) local directory —
 * the "refuse the one you do not support, with a reason" half of issue
 * #603's instructions, applied to the target-kind axis rather than the
 * workInPlace axis (which gets the "handle both explicitly" half instead,
 * per `isWorkInPlace` above).
 */

/** One checkpoint's wire-facing metadata — mirrors `@loombox/supervisor`'s `GitCheckpoint` one-for-one, plus `isWorkInPlace` (this file's own doc comment). */
export const gitCheckpointV1 = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  message: z.string(),
  createdAt: z.number(),
  commit: z.string().min(1),
  baseCommit: z.string().min(1),
  hasStagedChanges: z.boolean(),
  hasUnstagedChanges: z.boolean(),
  hasUntrackedFiles: z.boolean(),
  isWorkInPlace: z.boolean(),
});
export type GitCheckpointV1 = z.infer<typeof gitCheckpointV1>;

/** Mirrors `@loombox/supervisor`'s `RestorePreview`, plus `isWorkInPlace` (this file's own doc comment). */
export const restorePreviewV1 = z.object({
  checkpointId: z.string().min(1),
  commitsSinceCheckpoint: z.number(),
  hasUncommittedChangesToDiscard: z.boolean(),
  isWorkInPlace: z.boolean(),
});
export type RestorePreviewV1 = z.infer<typeof restorePreviewV1>;

/** Mirrors `@loombox/supervisor`'s `RestoreResult` exactly — what a restore actually did (issue #603's "the node must report what it actually did"). */
export const restoreResultV1 = z.object({
  checkpointId: z.string().min(1),
  discardedUncommittedChanges: z.boolean(),
  commitsPreserved: z.number(),
});
export type RestoreResultV1 = z.infer<typeof restoreResultV1>;

/** Every named reason a checkpoint/restore operation can fail — one member per `GitCheckpointStore`/`FsSnapshotCheckpointStore`-thrown error class, plus three this wiring adds of its own: `checkpoint_not_found` mirrors `CheckpointNotFoundError` (`checkpoint_restore_preview`/`checkpoint_restore` only); `not_git_worktree`/`detached_head`/`dirty_submodule` mirror `NotAGitWorktreeError`/`DetachedHeadError`/`DirtySubmoduleError` (any of the four messages, via `assertUsable()`); `snapshot_too_large` mirrors `FsSnapshotCheckpointStore`'s own `SnapshotTooLargeError` (`checkpoint_create` only — issue #267's cost bound: a non-git working set past `MAX_FS_SNAPSHOT_FILES`/`MAX_FS_SNAPSHOT_BYTES` refuses rather than silently taking minutes); `unsupported_target` is this node's own refusal for an `ssh:`-target session (this file's own doc comment); `turn_in_progress` is `checkpoint_restore`'s own refusal while the session's agent is actively mid-turn, so a restore is never immediately raced by an in-flight write; `unknown` covers anything else (a real git/filesystem failure neither store's own error classes name). */
export const checkpointErrorTypeV1 = z.enum([
  'not_git_worktree',
  'detached_head',
  'dirty_submodule',
  'snapshot_too_large',
  'checkpoint_not_found',
  'unsupported_target',
  'turn_in_progress',
  'unknown',
]);
export type CheckpointErrorTypeV1 = z.infer<typeof checkpointErrorTypeV1>;

/** The `outcome: 'error'` member every checkpoint result payload below shares. */
const checkpointErrorOutcomeV1 = z.object({
  outcome: z.literal('error'),
  errorType: checkpointErrorTypeV1,
  message: z.string().min(1),
});

/** A client asks the owning node to take a checkpoint of a session's worktree right now (issue #268's "on demand"). No envelope on the request wrapper itself carries the content — `message` (optional; auto-labeled when omitted, mirroring `GitCheckpointStore.checkpoint()`'s own default) travels inside `envelope`. */
export const checkpointCreate = z.object({
  type: z.literal('checkpoint_create'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type CheckpointCreate = z.infer<typeof checkpointCreate>;

/** The plaintext a `checkpoint_create` envelope decrypts to. */
export const checkpointCreatePayloadV1 = z.object({
  message: z.string().trim().min(1).optional(),
});
export type CheckpointCreatePayloadV1 = z.infer<typeof checkpointCreatePayloadV1>;

/** Parses and validates a decrypted `checkpoint_create` payload, throwing on an invalid one. */
export function parseCheckpointCreatePayloadV1(data: unknown): CheckpointCreatePayloadV1 {
  return checkpointCreatePayloadV1.parse(data);
}

/** Same as {@link parseCheckpointCreatePayloadV1} but never throws; returns zod's result. */
export function safeParseCheckpointCreatePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, CheckpointCreatePayloadV1> {
  return checkpointCreatePayloadV1.safeParse(data);
}

/** The owning node's reply to `checkpoint_create` — the checkpoint it just took, or why it couldn't. */
export const checkpointResult = z.object({
  type: z.literal('checkpoint_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type CheckpointResult = z.infer<typeof checkpointResult>;

/** The plaintext a `checkpoint_result` envelope decrypts to. */
export const checkpointResultPayloadV1 = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ok'), checkpoint: gitCheckpointV1 }),
  checkpointErrorOutcomeV1,
]);
export type CheckpointResultPayloadV1 = z.infer<typeof checkpointResultPayloadV1>;

/** Parses and validates a decrypted `checkpoint_result` payload, throwing on an invalid one. */
export function parseCheckpointResultPayloadV1(data: unknown): CheckpointResultPayloadV1 {
  return checkpointResultPayloadV1.parse(data);
}

/** Same as {@link parseCheckpointResultPayloadV1} but never throws; returns zod's result. */
export function safeParseCheckpointResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, CheckpointResultPayloadV1> {
  return checkpointResultPayloadV1.safeParse(data);
}

/** A client asks the owning node for every checkpoint taken so far for this session. No envelope: asking carries no content, only which session to ask about. */
export const checkpointList = z.object({
  type: z.literal('checkpoint_list'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type CheckpointList = z.infer<typeof checkpointList>;

/** The owning node's reply to `checkpoint_list`. */
export const checkpointListResult = z.object({
  type: z.literal('checkpoint_list_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type CheckpointListResult = z.infer<typeof checkpointListResult>;

/** The plaintext a `checkpoint_list_result` envelope decrypts to. */
export const checkpointListResultPayloadV1 = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ok'), checkpoints: z.array(gitCheckpointV1) }),
  checkpointErrorOutcomeV1,
]);
export type CheckpointListResultPayloadV1 = z.infer<typeof checkpointListResultPayloadV1>;

/** Parses and validates a decrypted `checkpoint_list_result` payload, throwing on an invalid one. */
export function parseCheckpointListResultPayloadV1(data: unknown): CheckpointListResultPayloadV1 {
  return checkpointListResultPayloadV1.parse(data);
}

/** Same as {@link parseCheckpointListResultPayloadV1} but never throws; returns zod's result. */
export function safeParseCheckpointListResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, CheckpointListResultPayloadV1> {
  return checkpointListResultPayloadV1.safeParse(data);
}

/** A client asks the owning node what restoring to `checkpointId` would do, with no side effects (this file's own doc comment). No envelope: `checkpointId` is an opaque id, not content — mirrors `terminal_close`'s `terminalId`. */
export const checkpointRestorePreview = z.object({
  type: z.literal('checkpoint_restore_preview'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  checkpointId: z.string().min(1),
});
export type CheckpointRestorePreview = z.infer<typeof checkpointRestorePreview>;

/** The owning node's reply to `checkpoint_restore_preview`. */
export const checkpointRestorePreviewResult = z.object({
  type: z.literal('checkpoint_restore_preview_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type CheckpointRestorePreviewResult = z.infer<typeof checkpointRestorePreviewResult>;

/** The plaintext a `checkpoint_restore_preview_result` envelope decrypts to. */
export const checkpointRestorePreviewResultPayloadV1 = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ok'), preview: restorePreviewV1 }),
  checkpointErrorOutcomeV1,
]);
export type CheckpointRestorePreviewResultPayloadV1 = z.infer<
  typeof checkpointRestorePreviewResultPayloadV1
>;

/** Parses and validates a decrypted `checkpoint_restore_preview_result` payload, throwing on an invalid one. */
export function parseCheckpointRestorePreviewResultPayloadV1(
  data: unknown,
): CheckpointRestorePreviewResultPayloadV1 {
  return checkpointRestorePreviewResultPayloadV1.parse(data);
}

/** Same as {@link parseCheckpointRestorePreviewResultPayloadV1} but never throws; returns zod's result. */
export function safeParseCheckpointRestorePreviewResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, CheckpointRestorePreviewResultPayloadV1> {
  return checkpointRestorePreviewResultPayloadV1.safeParse(data);
}

/** A client asks the owning node to actually roll back to `checkpointId` — destructive (this file's own doc comment on `confirm`). No envelope, same reasoning as `checkpoint_restore_preview`. */
export const checkpointRestore = z.object({
  type: z.literal('checkpoint_restore'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  checkpointId: z.string().min(1),
  confirm: z.boolean(),
});
export type CheckpointRestore = z.infer<typeof checkpointRestore>;

/** The owning node's reply to `checkpoint_restore`. */
export const checkpointRestoreResult = z.object({
  type: z.literal('checkpoint_restore_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type CheckpointRestoreResult = z.infer<typeof checkpointRestoreResult>;

/** The plaintext a `checkpoint_restore_result` envelope decrypts to — see this file's own doc comment for why `confirmation_required` is a distinct outcome from `error`. */
export const checkpointRestoreResultPayloadV1 = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ok'), result: restoreResultV1 }),
  z.object({ outcome: z.literal('confirmation_required'), preview: restorePreviewV1 }),
  checkpointErrorOutcomeV1,
]);
export type CheckpointRestoreResultPayloadV1 = z.infer<typeof checkpointRestoreResultPayloadV1>;

/** Parses and validates a decrypted `checkpoint_restore_result` payload, throwing on an invalid one. */
export function parseCheckpointRestoreResultPayloadV1(
  data: unknown,
): CheckpointRestoreResultPayloadV1 {
  return checkpointRestoreResultPayloadV1.parse(data);
}

/** Same as {@link parseCheckpointRestoreResultPayloadV1} but never throws; returns zod's result. */
export function safeParseCheckpointRestoreResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, CheckpointRestoreResultPayloadV1> {
  return checkpointRestoreResultPayloadV1.safeParse(data);
}
