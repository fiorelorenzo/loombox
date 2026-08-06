import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';
import { checkpointErrorTypeV1 } from './checkpoint';

/**
 * Wire surface for turn-indexed session rewind (design spec
 * `2026-08-05-zed-parity-decisions.md` §3's C6-3; issue #747) — built on
 * top of #805's `GitCheckpointStore` wiring (`checkpoint.ts`), not a
 * replacement for it: `checkpoint_create`/`_list`/`_restore_preview`/
 * `_restore` are still the general-purpose engine surface (#268's own
 * on-demand checkpoint UI), while `session_rewind_preview`/`session_rewind`
 * below are the higher-level "go back to turn N" operation that (1) maps a
 * turn number onto the checkpoint #805 already took before it — reading
 * back its own `auto: before turn <n>` label, its own documented seam,
 * rather than a separate index this wiring would have to keep in sync —
 * and (2) truncates the session's transcript to match in the SAME
 * operation, so the thread and the worktree can never disagree about which
 * turn the session is at. Neither of those two things is `checkpoint_*`'s
 * job: it only ever touches the worktree, on an id a caller already has.
 *
 * ## Turn addressing: a plain, node-resolved integer
 *
 * `turn` is the same 1-based counter `@loombox/node`'s
 * `NodeDaemon.autoCheckpointBeforeTurn` already stamps into its checkpoint
 * labels (`auto: before turn <n>`) — NOT the ACP-level `turn:<n>`/`resume:
 * <n>` id `AcpTranscriptUpdate.turnId` carries (the id `checkpoint.ts`'s
 * sibling feature, session fork/#746, addresses a turn by). Deliberately
 * plainer than that: this is meant to be everyday and casual (a
 * confirmation dialog, a "rewind to here" click on a turn already
 * numbered in the transcript UI), and no client ever needs to have
 * already rendered `TranscriptItem.turnId` to name a target —
 * "go back to what turn 3 looked like" is exactly how a human
 * thinks about it, and the node is the one place that already knows the
 * checkpoint numbering (from its own labels) is 1:1 with the transcript's
 * own turn order, so it resolves both from that single, node-side lookup.
 * Rewinding to `turn: N` means restoring the checkpoint taken before turn
 * `N + 1` (the earliest point after turn `N`'s own effects landed and
 * before anything past it began) and truncating the transcript to keep
 * exactly turns `1..N` — `turn: 0` is a valid target (rewind to before any
 * turn ran at all: an empty transcript, the pristine worktree).
 *
 * ## Preview and restore, mirroring `checkpoint_restore_preview`/`_restore` exactly
 *
 * `session_rewind_preview` computes what a rewind to `turn` would do, with
 * no side effects — a real commit's changes (files) and turns it would
 * discard, so a confirmation dialog can name them, per this issue's own
 * "the confirmation must name what will be lost, in files and in turns".
 * `session_rewind` is the destructive call: `confirm` is a REQUIRED,
 * no-default boolean, exactly like `checkpoint_restore`'s own — sending
 * `confirm: false` (or omitting it) gets `outcome: 'confirmation_required'`
 * back, carrying the SAME preview shape `session_rewind_preview` returns,
 * rather than this file inventing a second, differently-shaped confirmation
 * mechanism next to #805's already-established one (this issue's own "use
 * it rather than inventing a second confirm"). Every real rewind discards
 * at least one turn's transcript (`turn` must be strictly less than the
 * session's current turn count, or there is nothing to rewind — see
 * `rewind_error_type_v1`'s `turn_not_found`), so unlike
 * `checkpoint_restore` (which only gates on uncommitted worktree state),
 * confirmation here is required whenever `turnsAtRisk > 0` — i.e. for
 * every valid rewind — matching this issue's own "Destructive, and
 * confirmed before it runs" as an unconditional rule, not a conditional one.
 *
 * `isWorkInPlace` on {@link rewindPreviewV1} is #805's own flag
 * (`gitCheckpointV1`/`restorePreviewV1`'s own doc comment), carried
 * straight through: a `workInPlace` session's worktree IS the user's real
 * project folder, so this issue's "warn accordingly" is a client-side
 * rendering decision made off this same field, not a second one invented
 * here.
 *
 * ## `ssh:` sessions and a session with no live agent
 *
 * An `ssh:`-target session gets `errorType: 'unsupported_target'`, for
 * exactly the reason `checkpoint.ts`'s own doc comment gives:
 * `GitCheckpointStore` spawns `git` as a LOCAL child process, so a remote
 * `worktreePath` is not reachable from this node at all — this issue's own
 * "surface that honestly rather than offering a control that cannot work".
 * A session with no live agent (reloaded `'disconnected'` after a node
 * restart, issue #702's real state) gets `errorType: 'no_live_agent'`:
 * unlike a worktree restore, truncating a transcript needs the actual
 * `AgentSession` object holding it, which by definition does not exist
 * without a live bridge — reviving one on demand is issue #706's own
 * scope, not a contained fix belonging here (see `@loombox/node`'s
 * `handlePromptInject`/`handleConfigOption` for the same refusal already
 * applied to prompting/config on a disconnected session).
 */

/** One file {@link filesAffectedByRestore}-style preview data names as at risk — mirrors `@loombox/supervisor`'s `RestoreFileChange` one-for-one. */
export const rewindFileChangeV1 = z.object({
  path: z.string().min(1),
  action: z.enum(['restore', 'delete']),
});
export type RewindFileChangeV1 = z.infer<typeof rewindFileChangeV1>;

/** Every named reason a rewind operation can fail — `checkpointErrorTypeV1`'s own vocabulary (the underlying `GitCheckpointStore` restore this rides on can fail for any of those same reasons) plus two this wiring adds of its own: `turn_not_found` (`turn` doesn't map to a checkpoint this session ever took — negative, or at/past the session's current turn count) and `no_live_agent` (this file's own doc comment). */
export const rewindErrorTypeV1 = z.enum([
  ...checkpointErrorTypeV1.options,
  'turn_not_found',
  'no_live_agent',
]);
export type RewindErrorTypeV1 = z.infer<typeof rewindErrorTypeV1>;

/** The `outcome: 'error'` member every rewind result payload below shares. */
const rewindErrorOutcomeV1 = z.object({
  outcome: z.literal('error'),
  errorType: rewindErrorTypeV1,
  message: z.string().min(1),
});

/** What rewinding to `turn` would do, computed with no side effects — this file's own doc comment for exactly what each field means. */
export const rewindPreviewV1 = z.object({
  turn: z.number().int().nonnegative(),
  /** The checkpoint this rewind would restore — informational; a caller never needs to pass this back anywhere. */
  checkpointId: z.string().min(1),
  isWorkInPlace: z.boolean(),
  /** How many turns (transcript-wise) this rewind would discard — always `>= 1` for a valid target. */
  turnsAtRisk: z.number().int().positive(),
  /** Every file whose on-disk content would differ afterward. */
  filesAtRisk: z.array(rewindFileChangeV1),
  /** Real commits made on this worktree's branch since the target checkpoint — never removed or rewritten by the restore itself (mirrors `restorePreviewV1`'s own field). */
  commitsSinceCheckpoint: z.number().int().nonnegative(),
});
export type RewindPreviewV1 = z.infer<typeof rewindPreviewV1>;

/** What a rewind actually did, as an explicit record rather than a silent success (mirrors `restoreResultV1`'s own "the node must report what it actually did"). */
export const rewindResultV1 = z.object({
  turn: z.number().int().nonnegative(),
  checkpointId: z.string().min(1),
  turnsDiscarded: z.number().int().positive(),
  filesChanged: z.array(rewindFileChangeV1),
  discardedUncommittedChanges: z.boolean(),
  commitsPreserved: z.number().int().nonnegative(),
});
export type RewindResultV1 = z.infer<typeof rewindResultV1>;

/** A client asks the owning node what rewinding this session to `turn` would do, with no side effects (this file's own doc comment). No envelope: `turn` is a plain integer, not content — mirrors `checkpoint_restore_preview`'s `checkpointId`. */
export const sessionRewindPreview = z.object({
  type: z.literal('session_rewind_preview'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  turn: z.number().int().nonnegative(),
});
export type SessionRewindPreview = z.infer<typeof sessionRewindPreview>;

/** The owning node's reply to `session_rewind_preview`. */
export const sessionRewindPreviewResult = z.object({
  type: z.literal('session_rewind_preview_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type SessionRewindPreviewResult = z.infer<typeof sessionRewindPreviewResult>;

/** The plaintext a `session_rewind_preview_result` envelope decrypts to. */
export const sessionRewindPreviewResultPayloadV1 = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ok'), preview: rewindPreviewV1 }),
  rewindErrorOutcomeV1,
]);
export type SessionRewindPreviewResultPayloadV1 = z.infer<
  typeof sessionRewindPreviewResultPayloadV1
>;

/** Parses and validates a decrypted `session_rewind_preview_result` payload, throwing on an invalid one. */
export function parseSessionRewindPreviewResultPayloadV1(
  data: unknown,
): SessionRewindPreviewResultPayloadV1 {
  return sessionRewindPreviewResultPayloadV1.parse(data);
}

/** Same as {@link parseSessionRewindPreviewResultPayloadV1} but never throws; returns zod's result. */
export function safeParseSessionRewindPreviewResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SessionRewindPreviewResultPayloadV1> {
  return sessionRewindPreviewResultPayloadV1.safeParse(data);
}

/** A client asks the owning node to actually rewind this session to `turn` — destructive (this file's own doc comment on `confirm`). No envelope, same reasoning as `session_rewind_preview`. */
export const sessionRewind = z.object({
  type: z.literal('session_rewind'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  turn: z.number().int().nonnegative(),
  confirm: z.boolean(),
});
export type SessionRewind = z.infer<typeof sessionRewind>;

/** The owning node's reply to `session_rewind`. */
export const sessionRewindResult = z.object({
  type: z.literal('session_rewind_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type SessionRewindResult = z.infer<typeof sessionRewindResult>;

/** The plaintext a `session_rewind_result` envelope decrypts to — three outcomes, mirroring `checkpointRestoreResultPayloadV1`'s own shape exactly (this file's own doc comment for why `confirmation_required` reuses #805's mechanism rather than inventing a second one). */
export const sessionRewindResultPayloadV1 = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ok'), result: rewindResultV1 }),
  z.object({ outcome: z.literal('confirmation_required'), preview: rewindPreviewV1 }),
  rewindErrorOutcomeV1,
]);
export type SessionRewindResultPayloadV1 = z.infer<typeof sessionRewindResultPayloadV1>;

/** Parses and validates a decrypted `session_rewind_result` payload, throwing on an invalid one. */
export function parseSessionRewindResultPayloadV1(data: unknown): SessionRewindResultPayloadV1 {
  return sessionRewindResultPayloadV1.parse(data);
}

/** Same as {@link parseSessionRewindResultPayloadV1} but never throws; returns zod's result. */
export function safeParseSessionRewindResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SessionRewindResultPayloadV1> {
  return sessionRewindResultPayloadV1.safeParse(data);
}
