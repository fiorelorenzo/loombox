import { describe, expect, it } from 'vitest';

import { RunStatusTracker } from './run-status-tracker';

describe('RunStatusTracker (SPEC §7.15; issue #247)', () => {
  it('reads unknown with zero entries for a session that has never completed a run', () => {
    const tracker = new RunStatusTracker({ now: () => 1000 });
    expect(tracker.getState('sess-1')).toEqual({ state: 'unknown', entries: [], updatedAt: 1000 });
  });

  it('records a failing run and aggregates to failing', () => {
    const tracker = new RunStatusTracker({ now: () => 1000 });

    const status = tracker.record('sess-1', 'test', 'run-1', { outcome: 'fail', exitCode: 1 });

    expect(status.state).toBe('failing');
    expect(status.entries).toEqual([
      { kind: 'test', outcome: 'fail', runId: 'run-1', reason: undefined, updatedAt: 1000 },
    ]);
  });

  it('a could_not_start outcome also aggregates to failing, with its own reason carried through', () => {
    const tracker = new RunStatusTracker({ now: () => 1000 });

    const status = tracker.record('sess-1', 'lint', 'run-1', {
      outcome: 'could_not_start',
      exitCode: null,
      reason: 'command not found',
    });

    expect(status.state).toBe('failing');
    expect(status.entries[0]?.reason).toBe('command not found');
  });

  it('a passing run clears the failing aggregate for that kind, back to passing', () => {
    const tracker = new RunStatusTracker({ now: () => 1000 });

    tracker.record('sess-1', 'test', 'run-1', { outcome: 'fail', exitCode: 1 });
    let status = tracker.record('sess-1', 'test', 'run-2', { outcome: 'pass', exitCode: 0 });

    expect(status.state).toBe('passing');
    expect(status.entries).toHaveLength(1);
    expect(status.entries[0]?.runId).toBe('run-2');

    status = tracker.getState('sess-1');
    expect(status.state).toBe('passing');
  });

  it('aggregates to failing as long as ANY tracked kind is failing, even while others pass', () => {
    const tracker = new RunStatusTracker({ now: () => 1000 });

    tracker.record('sess-1', 'test', 'run-1', { outcome: 'pass', exitCode: 0 });
    const status = tracker.record('sess-1', 'lint', 'run-2', { outcome: 'fail', exitCode: 1 });

    expect(status.state).toBe('failing');
    expect(status.entries).toHaveLength(2);
  });

  it('a cancelled run is never recorded — a previously-passing kind stays passing, not lost', () => {
    const tracker = new RunStatusTracker({ now: () => 1000 });

    tracker.record('sess-1', 'test', 'run-1', { outcome: 'pass', exitCode: 0 });
    const status = tracker.record('sess-1', 'test', 'run-2', {
      outcome: 'fail',
      exitCode: null,
      cancelled: true,
    });

    expect(status.state).toBe('passing');
    expect(status.entries).toEqual([
      { kind: 'test', outcome: 'pass', runId: 'run-1', reason: undefined, updatedAt: 1000 },
    ]);
  });

  it('a re-run of the same kind replaces its previous entry rather than accumulating duplicates', () => {
    const tracker = new RunStatusTracker({ now: () => 1000 });

    tracker.record('sess-1', 'test', 'run-1', { outcome: 'fail', exitCode: 1 });
    tracker.record('sess-1', 'test', 'run-2', { outcome: 'fail', exitCode: 1 });
    const status = tracker.getState('sess-1');

    expect(status.entries).toHaveLength(1);
    expect(status.entries[0]?.runId).toBe('run-2');
  });

  it('tracks sessions independently', () => {
    const tracker = new RunStatusTracker({ now: () => 1000 });

    tracker.record('sess-1', 'test', 'run-1', { outcome: 'fail', exitCode: 1 });
    expect(tracker.getState('sess-2')).toEqual({ state: 'unknown', entries: [], updatedAt: 1000 });
  });

  it('forget() clears a session entirely', () => {
    const tracker = new RunStatusTracker({ now: () => 1000 });

    tracker.record('sess-1', 'test', 'run-1', { outcome: 'fail', exitCode: 1 });
    tracker.forget('sess-1');

    expect(tracker.getState('sess-1')).toEqual({ state: 'unknown', entries: [], updatedAt: 1000 });
  });
});
