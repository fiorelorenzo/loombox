import type { AcpTranscriptUpdate } from '@loombox/providers-core';

/**
 * Cuts an ordered `AcpTranscriptUpdate[]` (a session's full history, oldest
 * first — `AgentSession.getTranscriptUpdates()`'s own shape) down to
 * everything up to and including `turnId`'s own turn, for a session fork's
 * copied history (design spec `2026-08-05-zed-parity-decisions.md` §3's
 * C6-2; issue #746). Returns `undefined` if `turnId` never appears in
 * `updates` at all — `NodeDaemon.forkSessionInternal` treats that as a
 * refusal reason (an unrecognized/stale turn id), never a silent empty
 * fork.
 *
 * Not every update carries its own `turnId`: `AcpMessageChunkUpdate.turnId`
 * is required, but `AcpToolCallUpdate.turnId` is optional (a
 * `tool_call_update` patch commonly omits it, relying on the item the
 * reducer already created via an earlier `tool_call`), and
 * `AcpPlanUpdate`/`AcpUsageUpdate` never carry one at all — they're
 * session-level, not per-turn. Rather than requiring every entry to
 * restate `turnId`, this tracks a running "current turn": an update with
 * no `turnId` of its own inherits whichever turn the most recent `turnId`
 * belonged to, the same assumption the client-side reducer already makes
 * (`transcript.ts`'s `reduceToolCall` merges a turnId-less update onto the
 * existing item by `id`, never a fresh turn lookup). Once every entry
 * belonging to `turnId` has been collected and a later turn's own first
 * `turnId`'d update arrives, the cut point is already fixed and scanning
 * stops — a turn never resumes after a later one starts.
 */
export function cutTranscriptAtTurn(
  updates: readonly AcpTranscriptUpdate[],
  turnId: string,
): AcpTranscriptUpdate[] | undefined {
  let currentTurn: string | undefined;
  let cutIndex = -1;
  let sawTurn = false;

  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    const ownTurnId = 'turnId' in update ? update.turnId : undefined;
    if (ownTurnId) currentTurn = ownTurnId;

    if (currentTurn === turnId) {
      cutIndex = i;
      sawTurn = true;
    } else if (sawTurn) {
      // Every entry belonging to `turnId` is already collected and a
      // different, later turn has confirmed itself — the cut point is
      // final.
      break;
    }
  }

  if (!sawTurn) return undefined;
  return updates.slice(0, cutIndex + 1);
}
