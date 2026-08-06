/**
 * Per-turn edit aggregation (issue #740, settled pick C1-3 in
 * `docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §3 "The
 * thread"). Every tool call already carries a `turnId`
 * (`packages/providers/core/src/transcript.ts:38-45`) and, when it edited a
 * file, an ACP `Diff` (`{path, oldText, newText}`) the client already holds
 * — this module only groups what's already in `TranscriptState.items` by
 * turn and sums `$lib/diff.ts`'s `diffStats` over it. No new wire message,
 * no second diff implementation: `TurnFileDiff.oldText`/`newText` below are
 * literally the same `AcpDiff` fields `EditWriteWidget.svelte` passes to
 * `DiffViewer`, so a turn summary bar and the tool card it came from are
 * providing two views onto the exact same data, not two sources of it.
 *
 * Read-only by construction (issue #740's own decision, not a
 * simplification — C1-4's keep/reject was explicitly not picked and
 * depends on #603): nothing here returns, accepts, or wraps any mutation
 * callback. `TurnFileDiff`/`TurnDiffSummary` are plain read models.
 */
import { diffStats } from '$lib/diff';
import type { TranscriptItem } from '@loombox/providers-core/browser';

/** One tool call's diff, aggregated into its turn — `toolCallId` is the same `TranscriptToolCallItem.id` mounted in the transcript, so a caller can use it as a stable jump target back to that exact row. */
export interface TurnFileDiff {
  toolCallId: string;
  path: string;
  oldText: string | null;
  newText: string;
  added: number;
  removed: number;
}

/** One turn's worth of edits, in transcript order. `files` is one entry per diff-carrying tool call — two edits to the same path in one turn (rare, but the data model allows it) are two separate rows with two separate diffs, never silently merged into one, since merging would mean inventing a diff `DiffViewer` never actually rendered. */
export interface TurnDiffSummary {
  turnId: string;
  files: TurnFileDiff[];
  totalAdded: number;
  totalRemoved: number;
}

/**
 * Every diff-carrying tool call belonging to `turnId`, aggregated —
 * `undefined` when the turn touched no files at all (issue #740's "a turn
 * with no edits shows no bar" acceptance line: callers check for
 * `undefined`, never render an empty bar).
 */
export function turnDiffSummary(
  items: readonly TranscriptItem[],
  turnId: string,
): TurnDiffSummary | undefined {
  const files: TurnFileDiff[] = [];
  for (const item of items) {
    if (item.type !== 'tool_call' || item.turnId !== turnId || !item.diff) continue;
    const stats = diffStats(item.diff.oldText, item.diff.newText);
    files.push({
      toolCallId: item.id,
      path: item.diff.path,
      oldText: item.diff.oldText,
      newText: item.diff.newText,
      added: stats.added,
      removed: stats.removed,
    });
  }
  if (files.length === 0) return undefined;
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const file of files) {
    totalAdded += file.added;
    totalRemoved += file.removed;
  }
  return { turnId, files, totalAdded, totalRemoved };
}

/**
 * The turn id of the transcript's most recent item that carries one —
 * `undefined` for an empty transcript, or one where every item is a
 * malformed tool call with no `turnId` at all (issue #548's `id: undefined`
 * cousin: a wire event can omit `turnId` too, and `TranscriptToolCallItem.
 * turnId` is typed `string | undefined` for exactly that reason).
 */
export function latestTurnId(items: readonly TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    // A resync gap (issue #729) carries no `turnId` of its own — treated
    // exactly like a malformed tool call missing one: keep looking
    // backward rather than stopping here.
    const turnId = item.type === 'gap' ? undefined : item.turnId;
    if (turnId !== undefined) return turnId;
  }
  return undefined;
}

/**
 * The turn summary bar's one data source (issue #740): the most recent
 * turn in the transcript, or `undefined` when there is no turn yet or its
 * latest turn touched no files. Deliberately "latest turn", not "every
 * turn that ever edited a file" — the bar lives above the composer as one
 * persistent strip (see `+page.svelte`'s `.canvas-footer`), answering "what
 * did the turn I'm looking at just do", not a standing changelog of the
 * whole session. A still-streaming turn's bar updates live as each edit's
 * `tool_call`/`tool_call_update` lands, same as every other live transcript
 * state; once a new turn starts, the bar switches to that turn (hiding
 * again until it has its own first edit) rather than keeping the previous
 * turn's totals around.
 */
export function latestTurnDiffSummary(
  items: readonly TranscriptItem[],
): TurnDiffSummary | undefined {
  const turnId = latestTurnId(items);
  if (turnId === undefined) return undefined;
  return turnDiffSummary(items, turnId);
}
