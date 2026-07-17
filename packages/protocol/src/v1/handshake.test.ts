import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_V1,
  SUPPORTED_PROTOCOL_VERSIONS,
  baseMessageV1,
  initialize,
  initializeResult,
  negotiateVersion,
  wireRole,
} from './handshake';

describe('PROTOCOL_V1', () => {
  it('is 1', () => {
    expect(PROTOCOL_V1).toBe(1);
  });
});

describe('SUPPORTED_PROTOCOL_VERSIONS', () => {
  it('contains both v0 and v1', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS.has(0)).toBe(true);
    expect(SUPPORTED_PROTOCOL_VERSIONS.has(PROTOCOL_V1)).toBe(true);
  });
});

describe('negotiateVersion', () => {
  it('picks the highest common version', () => {
    expect(negotiateVersion([0, 1, 2], [1, 2, 3])).toBe(2);
  });

  it('returns null when there is no overlap', () => {
    expect(negotiateVersion([5], [6])).toBeNull();
  });

  it('negotiates 0 between a v1 peer (supports {0,1}) and a v0-only peer (supports {0})', () => {
    expect(negotiateVersion([0, 1], [0])).toBe(0);
    expect(negotiateVersion([0], [0, 1])).toBe(0);
  });

  it('negotiates 1 between two v1 peers (both support {0,1})', () => {
    expect(negotiateVersion([0, 1], [0, 1])).toBe(1);
  });

  it('returns null when either side supports nothing', () => {
    expect(negotiateVersion([], [0, 1])).toBeNull();
    expect(negotiateVersion([0, 1], [])).toBeNull();
  });
});

describe('baseMessageV1', () => {
  it('accepts a message carrying protocolVersion 1', () => {
    expect(baseMessageV1.parse({ protocolVersion: 1 })).toEqual({ protocolVersion: 1 });
  });

  it('rejects a message carrying protocolVersion 0', () => {
    expect(() => baseMessageV1.parse({ protocolVersion: 0 })).toThrow();
  });
});

describe('wireRole', () => {
  it('accepts node and client', () => {
    expect(wireRole.parse('node')).toBe('node');
    expect(wireRole.parse('client')).toBe('client');
  });

  it('rejects any other role', () => {
    expect(() => wireRole.parse('relay')).toThrow();
  });
});

describe('initialize', () => {
  const valid = {
    type: 'initialize',
    protocolVersion: 1,
    role: 'node' as const,
    authToken: 'bearer-token-opaque',
    deviceId: 'device-1',
    devicePublicKey: 'YWJjZA==',
  };

  it('parses a valid initialize message', () => {
    expect(initialize.parse(valid)).toEqual(valid);
  });

  it('rejects a non-base64 devicePublicKey', () => {
    expect(() => initialize.parse({ ...valid, devicePublicKey: 'not base64!' })).toThrow();
  });

  it('rejects an empty authToken', () => {
    expect(() => initialize.parse({ ...valid, authToken: '' })).toThrow();
  });

  it('rejects an unknown role', () => {
    expect(() => initialize.parse({ ...valid, role: 'admin' })).toThrow();
  });

  it('rejects the wrong protocolVersion literal', () => {
    expect(() => initialize.parse({ ...valid, protocolVersion: 0 })).toThrow();
  });
});

describe('initializeResult', () => {
  const valid = {
    type: 'initialize_result',
    protocolVersion: 1,
    negotiatedVersion: 1,
    capabilities: ['e2e', 'ssh_targets'],
  };

  it('parses a valid initializeResult', () => {
    expect(initializeResult.parse(valid)).toEqual(valid);
  });

  it('allows a negotiatedVersion below this schema version (downgrade to v0)', () => {
    expect(initializeResult.parse({ ...valid, negotiatedVersion: 0 })).toEqual({
      ...valid,
      negotiatedVersion: 0,
    });
  });

  it('accepts an empty capabilities set', () => {
    expect(initializeResult.parse({ ...valid, capabilities: [] }).capabilities).toEqual([]);
  });

  it('rejects a non-array capabilities field', () => {
    expect(() => initializeResult.parse({ ...valid, capabilities: 'e2e' })).toThrow();
  });
});
