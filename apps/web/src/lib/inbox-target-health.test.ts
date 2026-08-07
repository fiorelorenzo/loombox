import { describe, expect, it } from 'vitest';

import { inboxTargetHealthContext } from './inbox-target-health';
import { TARGET_OVERLOAD_PERCENT } from './target-health';
import type { TargetListEntry } from './relay-client';

function target(overrides: Partial<TargetListEntry> = {}): TargetListEntry {
  return {
    nodeId: 'node-a',
    targetId: 'local',
    label: 'This machine',
    kind: 'local',
    reachable: true,
    providers: ['claude'],
    ...overrides,
  };
}

function healthyReading(overrides: Partial<NonNullable<TargetListEntry['health']>> = {}) {
  return {
    cpuPercent: 10,
    loadPercent: 10,
    memPercent: 20,
    memUsedBytes: 1,
    memTotalBytes: 10,
    diskPercent: 30,
    diskUsedBytes: 1,
    diskTotalBytes: 10,
    healthy: true,
    sampledAt: 1_000,
    ...overrides,
  };
}

describe('inboxTargetHealthContext (issue #204)', () => {
  it('returns undefined for a healthy target — nothing relevant to add to the row', () => {
    expect(inboxTargetHealthContext(target({ health: healthyReading() }))).toBeUndefined();
  });

  it('says "no data" — never a fabricated healthy reading — when the session\'s target was never resolved at all', () => {
    expect(inboxTargetHealthContext(undefined)).toEqual({
      state: 'no-data',
      message: 'target health: no data yet',
    });
  });

  it('says "no data" when the target is known but has never reported a health sample', () => {
    expect(inboxTargetHealthContext(target({ health: undefined }))).toEqual({
      state: 'no-data',
      message: 'target health: no data yet',
    });
  });

  it('reports unreachable with a relative "last checked" age when a stale sample exists', () => {
    const now = 61_000;
    const context = inboxTargetHealthContext(
      target({ health: healthyReading({ healthy: false, sampledAt: 1_000 }) }),
      now,
    );
    expect(context?.state).toBe('unreachable');
    expect(context?.message).toBe('target unreachable — last checked 1m ago');
  });

  it('reports unreachable without a sample age when the node itself has no live connection', () => {
    const context = inboxTargetHealthContext(target({ reachable: false, health: undefined }));
    expect(context).toEqual({
      state: 'unreachable',
      message: 'target unreachable — its node has no live connection to the relay',
    });
  });

  it('names every resource actually over threshold for an overloaded target, not just a bare label', () => {
    const context = inboxTargetHealthContext(
      target({
        health: healthyReading({
          loadPercent: 96,
          memPercent: 40,
          diskPercent: TARGET_OVERLOAD_PERCENT,
        }),
      }),
    );
    expect(context).toEqual({
      state: 'overloaded',
      message: 'target overloaded — load 96%, disk 90%',
    });
  });
});
