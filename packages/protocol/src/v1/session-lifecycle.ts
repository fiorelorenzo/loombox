import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Session archive (SPEC §7.2's "the board supports pin, tag, archive, and
 * filter to keep many projects manageable"; issue #512): the row-menu
 * action that finally lets a session's row — and, optionally, the isolated
 * git worktree and `loombox/session-<id>` branch #507 gave it — leave the
 * board for good, rather than accumulating forever with no way to prune
 * them (the gap #512 reports).
 */
export const sessionArchiveRequest = z.object({
  type: z.literal('session_archive_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  /**
   * Also delete the session's isolated git worktree and its
   * `loombox/session-<id>` branch. Ignored by a node for a session running
   * in place, which has no worktree of its own — removing it there would
   * delete the user's actual working copy.
   */
  removeWorktree: z.boolean(),
});
export type SessionArchiveRequest = z.infer<typeof sessionArchiveRequest>;

const sessionArchiveOk = z.object({ outcome: z.literal('ok') });
const sessionArchiveError = z.object({
  outcome: z.literal('error'),
  message: z.string().min(1),
});
/** The node's outcome: `'ok'` once the session record (and, if asked, its worktree/branch) is gone, or `'error'` with a message a human can act on — most commonly git refusing the worktree/branch removal. */
export const sessionArchiveResult = z.discriminatedUnion('outcome', [
  sessionArchiveOk,
  sessionArchiveError,
]);
export type SessionArchiveResult = z.infer<typeof sessionArchiveResult>;

/**
 * The owning node's reply, matched back to the request by `requestId`. Per
 * `packages/relay/src/relay.ts`, an `outcome: 'ok'` is published to every
 * client of the account, not only the requester — a second device holding
 * the same board must drop the row too, or it keeps one pointing at a
 * session that no longer exists.
 *
 * `sessionId` is routing metadata and already travels in the clear (SPEC
 * §8), so unlike most session-scoped traffic in this package there is no
 * encrypted envelope on either side of this pair: the relay routes on
 * `sessionId` alone, exactly like `session_resume`.
 */
export const sessionArchiveResponse = z.object({
  type: z.literal('session_archive_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  result: sessionArchiveResult,
});
export type SessionArchiveResponse = z.infer<typeof sessionArchiveResponse>;

/**
 * Fork a session from a turn into a brand-new one (design spec
 * `2026-08-05-zed-parity-decisions.md` §3's C6-2; issue #746): the row/turn
 * action that copies `sourceSessionId`'s transcript up to and including
 * `forkFromTurnId` into a new session and lets it diverge from there. The
 * source session and its worktree are never touched — see
 * `@loombox/node`'s `SessionManager.forkSession` doc comment for exactly
 * what the new session's own worktree is seeded from.
 *
 * Shaped like `sessionCreate` (`sessionId` is the NEW session's id,
 * client-generated; `privateEnvelope` decrypts to a `sessionPrivateMetaV1`
 * with `forkFromTurnId` set) plus `sessionArchiveRequest`'s `requestId`
 * correlation, since unlike an ordinary create — fire-and-forget, the
 * client just waits for `session_announce` — a fork has real, foreseeable
 * refusal cases (no active agent for the source, an unknown turn, a
 * non-`local` target) that must reach the requester as a visible reason,
 * never a silent drop.
 */
export const sessionForkRequest = z.object({
  type: z.literal('session_fork_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  targetId: z.string().min(1),
  provider: z.string().min(1),
  privateEnvelope: encryptedEnvelope,
});
export type SessionForkRequest = z.infer<typeof sessionForkRequest>;

const sessionForkOk = z.object({ outcome: z.literal('ok') });
const sessionForkError = z.object({
  outcome: z.literal('error'),
  message: z.string().min(1),
});
/** The node's outcome: `'ok'` once the fork's worktree is copied and its transcript seeded (its agent may still be spawning — that progress rides the new session's ordinary `session_status` events, exactly like any other creation), or `'error'` with a message a human can act on: no active agent for the source session, an unrecognized `forkFromTurnId`, or a target this node cannot fork on. */
export const sessionForkResult = z.discriminatedUnion('outcome', [
  sessionForkOk,
  sessionForkError,
]);
export type SessionForkResult = z.infer<typeof sessionForkResult>;

/**
 * The owning node's reply, matched back to the request by `requestId`.
 * Broadcast account-wide exactly like `sessionArchiveResponse` (a second
 * device's own pending fork spinner, if it somehow raced the same
 * `requestId`, would settle the same way — though in practice only the
 * requester ever holds a pending promise for it); the new session itself
 * reaches every device the ordinary way, via `session_announce`.
 */
export const sessionForkResponse = z.object({
  type: z.literal('session_fork_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  result: sessionForkResult,
});
export type SessionForkResponse = z.infer<typeof sessionForkResponse>;
