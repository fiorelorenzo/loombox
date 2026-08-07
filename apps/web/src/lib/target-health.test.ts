import { describe, expect, it } from 'vitest';

import { classifyTargetHealth, TARGET_OVERLOAD_PERCENT } from './target-health';
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

describe('classifyTargetHealth (issue #204 extraction of the original #736 classification)', () => {
  it("reports 'unreachable' when the owning node has no live connection, regardless of any stale health reading", () => {
    expect(classifyTargetHealth(target({ reachable: false, health: healthyReading() }))).toBe(
      'unreachable',
    );
  });

  it("reports 'no-data' when no target_status sample has ever arrived", () => {
    expect(classifyTargetHealth(target({ health: undefined }))).toBe('no-data');
  });

  it("reports 'unreachable' when the latest sample itself failed (healthy: false), never 'no-data'", () => {
    expect(classifyTargetHealth(target({ health: healthyReading({ healthy: false }) }))).toBe(
      'unreachable',
    );
  });

  it("reports 'no-data' — never a healthy zero — for a peer that predates loadPercent", () => {
    const { loadPercent: _loadPercent, ...withoutLoad } = healthyReading();
    expect(classifyTargetHealth(target({ health: withoutLoad }))).toBe('no-data');
  });

  it("reports 'overloaded' when load crosses the threshold", () => {
    expect(
      classifyTargetHealth(
        target({ health: healthyReading({ loadPercent: TARGET_OVERLOAD_PERCENT }) }),
      ),
    ).toBe('overloaded');
  });

  it("reports 'overloaded' when memory crosses the threshold", () => {
    expect(
      classifyTargetHealth(
        target({ health: healthyReading({ memPercent: TARGET_OVERLOAD_PERCENT }) }),
      ),
    ).toBe('overloaded');
  });

  it("reports 'overloaded' when disk crosses the threshold", () => {
    expect(
      classifyTargetHealth(
        target({ health: healthyReading({ diskPercent: TARGET_OVERLOAD_PERCENT }) }),
      ),
    ).toBe('overloaded');
  });

  it("reports 'healthy' when reachable, sampled, and every figure is under the threshold", () => {
    expect(classifyTargetHealth(target({ health: healthyReading() }))).toBe('healthy');
  });
});
