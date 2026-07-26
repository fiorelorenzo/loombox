import { z } from 'zod';
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
