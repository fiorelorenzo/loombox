import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_V1,
  SUPPORTED_PROTOCOL_VERSIONS,
  baseMessageV1,
  buildIdentityMismatch,
  buildIdentityV1,
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

  it('parses a valid initialize message with a buildIdentity attached (issue #655)', () => {
    const withBuild = { ...valid, buildIdentity: { version: '0.5.1', commit: 'abc123' } };
    expect(initialize.parse(withBuild)).toEqual(withBuild);
  });

  it('still parses a payload from a peer that predates buildIdentity — additive and optional', () => {
    expect(initialize.parse(valid)).toEqual(valid);
    expect(initialize.parse(valid).buildIdentity).toBeUndefined();
  });
});

describe('buildIdentityV1', () => {
  it('parses version alone (commit is independently optional)', () => {
    expect(buildIdentityV1.parse({ version: '0.5.1' })).toEqual({ version: '0.5.1' });
  });

  it('parses version + commit', () => {
    expect(buildIdentityV1.parse({ version: '0.5.1', commit: 'abc123' })).toEqual({
      version: '0.5.1',
      commit: 'abc123',
    });
  });

  it('rejects a missing version', () => {
    expect(() => buildIdentityV1.parse({ commit: 'abc123' })).toThrow();
  });

  it('rejects an empty version', () => {
    expect(() => buildIdentityV1.parse({ version: '' })).toThrow();
  });
});

describe('buildIdentityMismatch', () => {
  it('is false for two identical identities (outcome 1: same protocol, same build, silent)', () => {
    const identity = { version: '0.5.1', commit: 'abc123' };
    expect(buildIdentityMismatch(identity, { ...identity })).toBe(false);
  });

  it('is true when commits differ, even with the same version (outcome 2: surfaced)', () => {
    expect(
      buildIdentityMismatch(
        { version: '0.5.1', commit: 'abc123' },
        { version: '0.5.1', commit: 'def456' },
      ),
    ).toBe(true);
  });

  it('falls back to version when either side has no commit', () => {
    expect(
      buildIdentityMismatch({ version: '0.5.1' }, { version: '0.5.1', commit: 'def456' }),
    ).toBe(false);
    expect(buildIdentityMismatch({ version: '0.5.1' }, { version: '0.6.0' })).toBe(true);
  });

  it('is false when either side is absent — unknown never reads as behind', () => {
    const identity = { version: '0.5.1', commit: 'abc123' };
    expect(buildIdentityMismatch(undefined, identity)).toBe(false);
    expect(buildIdentityMismatch(identity, undefined)).toBe(false);
    expect(buildIdentityMismatch(undefined, undefined)).toBe(false);
  });

  it('never treats a version-only difference in isolation as ordering (equality only, no >/< semantics)', () => {
    // '0.10.0' would sort before '0.9.0' lexically, and semver-after
    // numerically — this function does neither, it only asks "identical?".
    expect(buildIdentityMismatch({ version: '0.10.0' }, { version: '0.9.0' })).toBe(true);
    expect(buildIdentityMismatch({ version: '0.9.0' }, { version: '0.10.0' })).toBe(true);
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

  it('parses a valid initializeResult with a buildIdentity attached (issue #655) — the relay announcing its own build', () => {
    const withBuild = { ...valid, buildIdentity: { version: '0.4.1', commit: 'def456' } };
    expect(initializeResult.parse(withBuild)).toEqual(withBuild);
  });

  it('still parses a payload from a relay that predates buildIdentity — additive and optional', () => {
    expect(initializeResult.parse(valid)).toEqual(valid);
    expect(initializeResult.parse(valid).buildIdentity).toBeUndefined();
  });
});
