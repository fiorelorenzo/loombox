import type { AcpTranscriptUpdate } from '@loombox/providers-core';
import type { GitCheckpoint } from '@loombox/supervisor';

/**
 * Free-text prefix on every checkpoint `NodeDaemon.autoCheckpointBeforeTurn`
 * auto-takes before a turn starts (issue #603) — moved here from
 * `node-daemon.ts` (still imported there, and still the one place that
 * writes it) because this module is now the seam it was left for: issue
 * #603's own doc comment named it "recognizable so a future rewind (issue
 * #747) can tell an automatic per-turn checkpoint from a manual one ...
 * without a dedicated field", and everything below reads it back.
 */
export const AUTO_CHECKPOINT_MESSAGE_PREFIX = 'auto: before turn ';

/**
 * Parses `auto: before turn <n>` back into `<n>` — the read side of
 * {@link AUTO_CHECKPOINT_MESSAGE_PREFIX}. `undefined` for a checkpoint
 * that isn't one of these: a manual, on-demand checkpoint (issue #268's
 * "named or auto-labeled ... on demand" — anything a caller labeled
 * itself), or a malformed/foreign one. Rewind only ever addresses the
 * automatic, per-turn-boundary checkpoints; a manual one has no turn
 * number to be reached by.
 */
export function parseAutoCheckpointTurnNumber(message: string): number | undefined {
  if (!message.startsWith(AUTO_CHECKPOINT_MESSAGE_PREFIX)) return undefined;
  const digits = message.slice(AUTO_CHECKPOINT_MESSAGE_PREFIX.length);
  if (!/^[1-9]\d*$/.test(digits)) return undefined;
  return Number(digits);
}

/**
 * Maps turn number → the checkpoint `NodeDaemon.autoCheckpointBeforeTurn`
 * took before it, built from a session's full checkpoint list (issue
 * #747's own "no index is built yet" seam — #805 left `auto: before turn
 * <n>` as the label to read back, so this reconstructs the index from it
 * rather than this wiring keeping a second, persisted structure of its
 * own in sync). Read fresh from `GitCheckpointStore.listCheckpoints()`
 * every call, exactly like every other checkpoint read this daemon does
 * ("fresh, never cached" — `getCheckpointStore`'s own doc comment) — the
 * checkpoints' hidden refs already ARE the persistence, so there is
 * nothing else to keep in sync. Order of `checkpoints` doesn't matter:
 * every entry is looked at once and keyed by its own parsed turn number.
 * A manual (non-auto) checkpoint is silently excluded (see
 * {@link parseAutoCheckpointTurnNumber}) — only the automatic per-turn
 * ones are addressable by turn number.
 */
export function buildTurnCheckpointIndex(
  checkpoints: readonly GitCheckpoint[],
): Map<number, GitCheckpoint> {
  const index = new Map<number, GitCheckpoint>();
  for (const checkpoint of checkpoints) {
    const turn = parseAutoCheckpointTurnNumber(checkpoint.message);
    if (turn !== undefined) index.set(turn, checkpoint);
  }
  return index;
}

/**
 * Resolves rewinding a session to `turn` (this file's own doc comment on
 * the "keep 1..N, discard N+1 onward" semantics — `@loombox/protocol`'s
 * `rewind.ts` module doc comment states the same contract wire-side) to
 * the checkpoint that captures exactly that state: the one taken before
 * turn `turn + 1`. `undefined` when no such checkpoint exists — either
 * `turn` is already at or past the session's current turn count (nothing
 * to discard) or, for `turn: 0`, the session has never taken its very
 * first auto-checkpoint yet — both cases `NodeDaemon` reports as
 * `errorType: 'turn_not_found'`.
 */
export function resolveRewindCheckpoint(
  checkpoints: readonly GitCheckpoint[],
  turn: number,
): GitCheckpoint | undefined {
  return buildTurnCheckpointIndex(checkpoints).get(turn + 1);
}

/**
 * Every distinct `turnId` appearing in `updates`, in first-appearance
 * order — the same "current turn" tracking `cutTranscriptAtTurn`
 * (`session-fork.ts`) already establishes for a turnId-less update
 * inheriting the most recent turnId, reused here (rather than a second,
 * possibly-inconsistent walk) so a rewind's turn-number resolution and
 * its transcript cut agree about where each turn's boundary actually is.
 * The ordinal position of a turnId in this list is what
 * {@link turnIdForTurnNumber} reads: turn `N` (1-based) is
 * `orderedTurnIds(updates)[N - 1]`, since `NodeDaemon.autoCheckpointBeforeTurn`
 * and the ACP-level turn-id AcpClient mints both advance once, in
 * lockstep, per real prompt call.
 */
export function orderedTurnIds(updates: readonly AcpTranscriptUpdate[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const update of updates) {
    const turnId = 'turnId' in update ? update.turnId : undefined;
    if (turnId && !seen.has(turnId)) {
      seen.add(turnId);
      ordered.push(turnId);
    }
  }
  return ordered;
}

/** The transcript's own `turnId` for turn number `turn` (1-based) — see {@link orderedTurnIds}'s own doc comment for why ordinal position, not a numeric/string format, is what's trusted. `undefined` if the transcript has never produced that many distinct turns. */
export function turnIdForTurnNumber(
  updates: readonly AcpTranscriptUpdate[],
  turn: number,
): string | undefined {
  return orderedTurnIds(updates)[turn - 1];
}
