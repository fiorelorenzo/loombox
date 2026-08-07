import type { RunStatusStateV1, TestRunnerKindV1 } from '@loombox/protocol';
import { isFailingRunOutcome } from '@loombox/shared';

import type { RunExitResult } from './test-runner-process';

export interface RunStatusTrackerOptions {
  now?: () => number;
}

interface RecordedEntry {
  kind: TestRunnerKindV1;
  outcome: RunExitResult['outcome'];
  runId: string;
  reason: string | undefined;
  updatedAt: number;
}

/**
 * This node's own in-memory memory of each session's LATEST completed
 * test/lint/build outcome per configured kind (SPEC §7.15; issue #247) —
 * the runner's sibling of `CiCheckWatcher`'s own latest-reading cache, but
 * event-driven off `run_exit` rather than polled. Not persisted across a
 * restart, exactly like `CiCheckWatcher`'s own `notifiedFailureSha`: a
 * fresh daemon has no completed runs to report yet, which is a legitimate
 * `'unknown'` starting state, never something to reconstruct from disk.
 *
 * A user-cancelled run (`RunExitResult.cancelled`) is never recorded here
 * at all — see `record`'s own guard — since a deliberate stop carries no
 * verdict on the code either way, and must never flip a kind that was
 * last known `'pass'` into looking abandoned/failing.
 */
export class RunStatusTracker {
  private readonly now: () => number;
  private readonly bySession = new Map<string, Map<TestRunnerKindV1, RecordedEntry>>();

  constructor(options: RunStatusTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private snapshot(sessionId: string): RunStatusStateV1 {
    const byKind = this.bySession.get(sessionId);
    const entries = byKind ? [...byKind.values()] : [];
    const state: RunStatusStateV1['state'] =
      entries.length === 0
        ? 'unknown'
        : entries.some((entry) => isFailingRunOutcome(entry.outcome))
          ? 'failing'
          : 'passing';
    return {
      state,
      entries: entries.map(({ kind, outcome, runId, reason, updatedAt }) => ({
        kind,
        outcome,
        runId,
        reason,
        updatedAt,
      })),
      updatedAt: this.now(),
    };
  }

  /** `sessionId`'s current aggregate run status — an untouched session (no run has ever completed) reads as `'unknown'` with zero entries, not `undefined`. */
  getState(sessionId: string): RunStatusStateV1 {
    return this.snapshot(sessionId);
  }

  /** Records `kind`'s terminal outcome for `sessionId` under `runId`, replacing whatever this kind's own previous entry was (a re-run always wins, whichever way it lands) — a no-op for a cancelled run (see this class's own doc comment). Returns the resulting snapshot so a caller can push `run_status` and decide whether to drive the auto-iterate loop from one call. */
  record(
    sessionId: string,
    kind: TestRunnerKindV1,
    runId: string,
    result: RunExitResult,
  ): RunStatusStateV1 {
    if (!result.cancelled) {
      let byKind = this.bySession.get(sessionId);
      if (!byKind) {
        byKind = new Map();
        this.bySession.set(sessionId, byKind);
      }
      byKind.set(kind, {
        kind,
        outcome: result.outcome,
        runId,
        reason: result.reason,
        updatedAt: this.now(),
      });
    }
    return this.snapshot(sessionId);
  }

  /** Forgets `sessionId` entirely — mirrors `CiCheckWatcher.unwatch`/`CiAutoIterateController.forget`, called from the same session-archival site. */
  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
