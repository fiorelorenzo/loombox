import { describe, expect, it } from 'vitest';
import { targetAnnounce, targetDescriptor, targetKind } from './targets';

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
