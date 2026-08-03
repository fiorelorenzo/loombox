import { describe, expect, it } from 'vitest';

import { SessionConcurrencyGate } from './session-concurrency-gate';

describe('SessionConcurrencyGate (SPEC §7.16, issue #252)', () => {
  it('acquires up to the configured cap, then refuses', () => {
    const gate = new SessionConcurrencyGate({ limits: { local: 2 } });

    expect(gate.tryAcquire('local')).toBe(true);
    expect(gate.tryAcquire('local')).toBe(true);
    expect(gate.runningCount('local')).toBe(2);

    // Over cap: starts queueing instead of launching.
    expect(gate.tryAcquire('local')).toBe(false);
    expect(gate.runningCount('local')).toBe(2);
  });

  it('falls back to defaultMax for a target id with no explicit limit', () => {
    const gate = new SessionConcurrencyGate({ defaultMax: 3 });
    expect(gate.maxFor('unconfigured')).toBe(3);
    expect(gate.tryAcquire('unconfigured')).toBe(true);
    expect(gate.tryAcquire('unconfigured')).toBe(true);
    expect(gate.tryAcquire('unconfigured')).toBe(true);
    expect(gate.tryAcquire('unconfigured')).toBe(false);
  });

  it('defaults defaultMax itself to 1 when omitted entirely', () => {
    const gate = new SessionConcurrencyGate();
    expect(gate.maxFor('anything')).toBe(1);
  });

  it('drains two queued sessions in FIFO order as running sessions release', () => {
    const gate = new SessionConcurrencyGate({ limits: { local: 1 } });
    const started: string[] = [];

    expect(gate.tryAcquire('local')).toBe(true); // session A takes the only slot

    gate.enqueue('local', 'B', () => started.push('B'));
    gate.enqueue('local', 'C', () => started.push('C'));
    expect(gate.queuedSessionIds('local')).toEqual(['B', 'C']);
    expect(started).toEqual([]);

    // A finishes: B (oldest queued) gets the slot next, not C.
    gate.release('local');
    expect(started).toEqual(['B']);
    expect(gate.queuedSessionIds('local')).toEqual(['C']);
    expect(gate.runningCount('local')).toBe(1); // the slot transferred, never freed

    // B finishes: C gets it.
    gate.release('local');
    expect(started).toEqual(['B', 'C']);
    expect(gate.queuedSessionIds('local')).toEqual([]);
    expect(gate.runningCount('local')).toBe(1);

    // C finishes: nothing left queued, the slot is genuinely freed.
    gate.release('local');
    expect(gate.runningCount('local')).toBe(0);
  });

  it('releases a slot on a crash/kill exactly like a clean finish (same release() call)', () => {
    const gate = new SessionConcurrencyGate({ limits: { local: 1 } });
    expect(gate.tryAcquire('local')).toBe(true);

    // A crash/kill and a clean stop both ultimately call release() once —
    // this class has no notion of "why" a slot was given back, which is the
    // point: there is exactly one release path, not one per failure mode,
    // so nothing can bypass it and leak.
    gate.release('local');
    expect(gate.runningCount('local')).toBe(0);
    expect(gate.tryAcquire('local')).toBe(true); // the slot is usable again
  });

  it('cancelling a queued session removes it and it never dequeues', () => {
    const gate = new SessionConcurrencyGate({ limits: { local: 1 } });
    const started: string[] = [];

    gate.tryAcquire('local'); // running session holds the only slot
    gate.enqueue('local', 'B', () => started.push('B'));
    gate.enqueue('local', 'C', () => started.push('C'));

    expect(gate.cancel('B')).toBe(true);
    expect(gate.queuedSessionIds('local')).toEqual(['C']);

    gate.release('local'); // the freed slot skips straight to C, B is gone for good
    expect(started).toEqual(['C']);
  });

  it('cancel is a safe no-op for a session that is running, already gone, or never existed', () => {
    const gate = new SessionConcurrencyGate({ limits: { local: 1 } });
    gate.tryAcquire('local');
    expect(gate.cancel('running-session')).toBe(false);
    expect(gate.cancel('never-heard-of-it')).toBe(false);
  });

  it('lowering the cap below the running count does not touch running sessions, only gates new ones', () => {
    const gate = new SessionConcurrencyGate({ limits: { local: 3 } });
    expect(gate.tryAcquire('local')).toBe(true);
    expect(gate.tryAcquire('local')).toBe(true);
    expect(gate.runningCount('local')).toBe(2);

    gate.setMax('local', 1); // lowered below the 2 already running

    expect(gate.runningCount('local')).toBe(2); // both still counted as running — nothing was killed
    expect(gate.tryAcquire('local')).toBe(false); // but a third can't start until one of the two frees up

    gate.release('local');
    expect(gate.runningCount('local')).toBe(1); // now at (the new) cap
    expect(gate.tryAcquire('local')).toBe(false); // still refuses — 1 >= the lowered cap of 1
  });

  it('a local and an ssh target keep fully independent caps and queues', () => {
    const gate = new SessionConcurrencyGate({ limits: { local: 4, 'ssh:box': 1 } });

    expect(gate.tryAcquire('local')).toBe(true);
    expect(gate.tryAcquire('local')).toBe(true);
    expect(gate.tryAcquire('ssh:box')).toBe(true);

    expect(gate.runningCount('local')).toBe(2);
    expect(gate.runningCount('ssh:box')).toBe(1);
    expect(gate.tryAcquire('ssh:box')).toBe(false); // ssh:box is at its own (lower) cap
    expect(gate.tryAcquire('local')).toBe(true); // local's own, higher cap is unaffected
  });
});
