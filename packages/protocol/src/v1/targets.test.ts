import { describe, expect, it } from 'vitest';
import {
  targetAnnounce,
  targetDescriptor,
  targetKind,
  targetList,
  targetListEntry,
  targetListRequest,
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

describe('targetListEntry', () => {
  const valid = {
    nodeId: 'node-1',
    targetId: 'local',
    label: 'This machine',
    kind: 'local' as const,
    reachable: true,
  };

  it('parses a valid entry', () => {
    expect(targetListEntry.parse(valid)).toEqual(valid);
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
