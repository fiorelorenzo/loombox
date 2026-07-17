import { describe, expect, it } from 'vitest';

import { InMemoryLeaseStore, SessionLeaseManager } from './session-lease';

/** A controllable clock so acquire/renew/expiry tests don't depend on real wall-clock timing. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('SessionLeaseManager', () => {
  it('grants an acquire on an unheld session', async () => {
    const manager = new SessionLeaseManager();
    const result = await manager.acquire('sess-1', 'node-a');
    expect(result.granted).toBe(true);
    if (result.granted) expect(result.lease.holderNodeId).toBe('node-a');
    expect(await manager.isLeaseholder('sess-1', 'node-a')).toBe(true);
  });

  it('refuses a second node acquiring a session whose lease is still live', async () => {
    const manager = new SessionLeaseManager();
    await manager.acquire('sess-1', 'node-a');

    const result = await manager.acquire('sess-1', 'node-b');
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.heldBy).toBe('node-a');
    expect(await manager.isLeaseholder('sess-1', 'node-b')).toBe(false);
    // The original holder is unaffected by the refused attempt.
    expect(await manager.isLeaseholder('sess-1', 'node-a')).toBe(true);
  });

  it('lets the current holder renew, extending the expiry, but refuses a renew from a non-holder', async () => {
    const clock = fakeClock();
    const manager = new SessionLeaseManager({ ttlMs: 1000, now: clock.now });
    await manager.acquire('sess-1', 'node-a');

    clock.advance(900); // still within the original 1000ms TTL
    const renewed = await manager.renew('sess-1', 'node-a');
    expect(renewed.granted).toBe(true);

    clock.advance(900); // would have expired at t=1000 without the renewal; now at t=1800
    expect(await manager.isLeaseholder('sess-1', 'node-a')).toBe(true);

    const refused = await manager.renew('sess-1', 'node-b');
    expect(refused.granted).toBe(false);
  });

  it('lets a lease expire, after which a different node can acquire it', async () => {
    const clock = fakeClock();
    const manager = new SessionLeaseManager({ ttlMs: 1000, now: clock.now });
    await manager.acquire('sess-1', 'node-a');

    clock.advance(1500); // past the 1000ms TTL, node-a never renewed
    expect(await manager.isLeaseholder('sess-1', 'node-a')).toBe(false);

    const result = await manager.acquire('sess-1', 'node-b');
    expect(result.granted).toBe(true);
    expect(await manager.isLeaseholder('sess-1', 'node-b')).toBe(true);
  });

  it('release() only works for the current holder, and frees the session for anyone', async () => {
    const manager = new SessionLeaseManager();
    await manager.acquire('sess-1', 'node-a');

    expect(await manager.release('sess-1', 'node-b')).toBe(false); // not the holder
    expect(await manager.isLeaseholder('sess-1', 'node-a')).toBe(true); // unaffected

    expect(await manager.release('sess-1', 'node-a')).toBe(true);
    expect(await manager.isLeaseholder('sess-1', 'node-a')).toBe(false);

    const result = await manager.acquire('sess-1', 'node-b');
    expect(result.granted).toBe(true);
  });

  it('reclaim() (the explicit handoff action) refuses while the lease is still live, and succeeds once it has expired', async () => {
    const clock = fakeClock();
    const manager = new SessionLeaseManager({ ttlMs: 1000, now: clock.now });
    await manager.acquire('sess-1', 'node-a');

    const tooEarly = await manager.reclaim('sess-1', 'node-b');
    expect(tooEarly.granted).toBe(false);
    if (!tooEarly.granted) expect(tooEarly.heldBy).toBe('node-a');

    clock.advance(1500);
    const handoff = await manager.reclaim('sess-1', 'node-b');
    expect(handoff.granted).toBe(true);
    expect(await manager.isLeaseholder('sess-1', 'node-b')).toBe(true);
    expect(await manager.isLeaseholder('sess-1', 'node-a')).toBe(false);
  });

  it('two independent SessionLeaseManagers sharing one LeaseStore behave as two nodes contending for the same session (the actual cross-node scenario)', async () => {
    const clock = fakeClock();
    const store = new InMemoryLeaseStore();
    const nodeA = new SessionLeaseManager({ store, ttlMs: 1000, now: clock.now });
    const nodeB = new SessionLeaseManager({ store, ttlMs: 1000, now: clock.now });

    const first = await nodeA.acquire('sess-1', 'node-a');
    expect(first.granted).toBe(true);
    const second = await nodeB.acquire('sess-1', 'node-b');
    expect(second.granted).toBe(false);

    clock.advance(1500);
    const reclaimed = await nodeB.reclaim('sess-1', 'node-b');
    expect(reclaimed.granted).toBe(true);
    expect(await nodeA.isLeaseholder('sess-1', 'node-a')).toBe(false);
    expect(await nodeB.isLeaseholder('sess-1', 'node-b')).toBe(true);
  });
});
