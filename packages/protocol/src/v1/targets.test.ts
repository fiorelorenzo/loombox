import { describe, expect, it } from 'vitest';
import {
  targetAnnounce,
  targetDescriptor,
  targetHealth,
  targetKind,
  targetList,
  targetListEntry,
  targetListRequest,
  targetResourceSample,
  targetStatus,
} from './targets';

describe('targetKind', () => {
  it('accepts local and ssh', () => {
    expect(targetKind.parse('local')).toBe('local');
    expect(targetKind.parse('ssh')).toBe('ssh');
  });

  it('rejects any other kind', () => {
    expect(() => targetKind.parse('docker')).toThrow();
  });
});

describe('targetDescriptor', () => {
  const valid = { id: 'target-1', kind: 'ssh' as const, label: 'devbox' };

  it('parses a valid target descriptor', () => {
    expect(targetDescriptor.parse(valid)).toEqual(valid);
  });

  it('rejects a missing label', () => {
    const { label: _label, ...rest } = valid;
    expect(() => targetDescriptor.parse(rest)).toThrow();
  });
});

describe('targetAnnounce', () => {
  const valid = {
    type: 'target_announce',
    protocolVersion: 1,
    nodeId: 'node-1',
    targets: [
      { id: 'local', kind: 'local' as const, label: 'This machine' },
      { id: 'ssh:devbox', kind: 'ssh' as const, label: 'devbox' },
    ],
  };

  it('parses a valid targetAnnounce with a mix of local and ssh targets', () => {
    expect(targetAnnounce.parse(valid)).toEqual(valid);
  });

  it('accepts an empty targets array', () => {
    expect(targetAnnounce.parse({ ...valid, targets: [] }).targets).toEqual([]);
  });

  it('rejects a malformed target in the list', () => {
    expect(() =>
      targetAnnounce.parse({ ...valid, targets: [{ id: 'x', kind: 'docker' }] }),
    ).toThrow();
  });
});

describe('targetListRequest', () => {
  const valid = {
    type: 'target_list_request',
    protocolVersion: 1,
    requestId: 'req-1',
  };

  it('parses a valid target_list_request', () => {
    expect(targetListRequest.parse(valid)).toEqual(valid);
  });

  it('rejects a missing requestId', () => {
    const { requestId: _requestId, ...rest } = valid;
    expect(() => targetListRequest.parse(rest)).toThrow();
  });
});

describe('targetHealth', () => {
  const valid = {
    cpuPercent: 42.5,
    memPercent: 60,
    memUsedBytes: 6_000_000_000,
    memTotalBytes: 16_000_000_000,
    diskPercent: 30,
    diskUsedBytes: 150_000_000_000,
    diskTotalBytes: 500_000_000_000,
    healthy: true,
    sampledAt: 1_700_000_000_000,
  };

  it('parses a valid health reading', () => {
    expect(targetHealth.parse(valid)).toEqual(valid);
  });

  it('rejects a percent above 100', () => {
    expect(() => targetHealth.parse({ ...valid, cpuPercent: 150 })).toThrow();
  });

  it('rejects a negative percent', () => {
    expect(() => targetHealth.parse({ ...valid, memPercent: -1 })).toThrow();
  });

  it('rejects a missing healthy flag', () => {
    const { healthy: _healthy, ...rest } = valid;
    expect(() => targetHealth.parse(rest)).toThrow();
  });

  it('accepts an unhealthy reading with zeroed-out figures (a failed sample)', () => {
    const failed = {
      cpuPercent: 0,
      memPercent: 0,
      memUsedBytes: 0,
      memTotalBytes: 0,
      diskPercent: 0,
      diskUsedBytes: 0,
      diskTotalBytes: 0,
      healthy: false,
      sampledAt: valid.sampledAt,
    };
    expect(targetHealth.parse(failed)).toEqual(failed);
  });
});

describe('targetResourceSample', () => {
  const valid = {
    targetId: 'ssh:devbox',
    cpuPercent: 12,
    memPercent: 20,
    memUsedBytes: 1,
    memTotalBytes: 2,
    diskPercent: 5,
    diskUsedBytes: 1,
    diskTotalBytes: 2,
    healthy: true,
    sampledAt: 1,
  };

  it('parses a valid sample', () => {
    expect(targetResourceSample.parse(valid)).toEqual(valid);
  });

  it('rejects a missing targetId', () => {
    const { targetId: _targetId, ...rest } = valid;
    expect(() => targetResourceSample.parse(rest)).toThrow();
  });
});

describe('targetStatus', () => {
  const valid = {
    type: 'target_status',
    protocolVersion: 1,
    nodeId: 'node-1',
    samples: [
      {
        targetId: 'local',
        cpuPercent: 12,
        memPercent: 20,
        memUsedBytes: 1,
        memTotalBytes: 2,
        diskPercent: 5,
        diskUsedBytes: 1,
        diskTotalBytes: 2,
        healthy: true,
        sampledAt: 1,
      },
    ],
  };

  it('parses a valid target_status', () => {
    expect(targetStatus.parse(valid)).toEqual(valid);
  });

  it('accepts an empty samples array', () => {
    expect(targetStatus.parse({ ...valid, samples: [] }).samples).toEqual([]);
  });

  it('rejects a malformed sample in the list', () => {
    expect(() =>
      targetStatus.parse({ ...valid, samples: [{ targetId: 'x', cpuPercent: 200 }] }),
    ).toThrow();
  });
});

describe('targetListEntry', () => {
  const valid = {
    nodeId: 'node-1',
    targetId: 'local',
    label: 'This machine',
    kind: 'local' as const,
    reachable: true,
  };

  it('parses a valid entry with no health yet', () => {
    expect(targetListEntry.parse(valid)).toEqual(valid);
  });

  it('parses a valid entry with a health reading attached', () => {
    const withHealth = {
      ...valid,
      health: {
        cpuPercent: 10,
        memPercent: 20,
        memUsedBytes: 1,
        memTotalBytes: 2,
        diskPercent: 5,
        diskUsedBytes: 1,
        diskTotalBytes: 2,
        healthy: true,
        sampledAt: 1,
      },
    };
    expect(targetListEntry.parse(withHealth)).toEqual(withHealth);
  });

  it('rejects a missing reachable flag', () => {
    const { reachable: _reachable, ...rest } = valid;
    expect(() => targetListEntry.parse(rest)).toThrow();
  });

  it('never carries anything beyond routing metadata (no path/secret fields survive parsing)', () => {
    const parsed = targetListEntry.parse({
      ...valid,
      sshPath: '/home/dev/secret-project',
      credential: 'super-secret',
    });
    expect(parsed).toEqual(valid);
  });
});

describe('targetList', () => {
  const valid = {
    type: 'target_list',
    protocolVersion: 1,
    requestId: 'req-1',
    targets: [
      {
        nodeId: 'node-1',
        targetId: 'local',
        label: 'This machine',
        kind: 'local' as const,
        reachable: true,
      },
      {
        nodeId: 'node-1',
        targetId: 'ssh:devbox',
        label: 'devbox',
        kind: 'ssh' as const,
        reachable: false,
      },
    ],
  };

  it('parses a valid target_list', () => {
    expect(targetList.parse(valid)).toEqual(valid);
  });

  it('accepts an empty targets array', () => {
    expect(targetList.parse({ ...valid, targets: [] }).targets).toEqual([]);
  });

  it('rejects a malformed entry in the list', () => {
    expect(() =>
      targetList.parse({ ...valid, targets: [{ nodeId: 'x', targetId: 'y' }] }),
    ).toThrow();
  });
});
