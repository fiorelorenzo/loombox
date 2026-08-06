import { describe, expect, it } from 'vitest';
import { wireMessageV1 } from './message';
import {
  EMPTY_PERMISSION_POLICY_V1,
  parsePermissionPolicyResultPayloadV1,
  parsePermissionPolicySetPayloadV1,
  parsePermissionPolicyViolationPayloadV1,
  permissionPolicyGet,
  permissionPolicyResult,
  permissionPolicySet,
  permissionPolicyV1,
  permissionPolicyViolation,
  permissionRuleSetV1,
  safeParsePermissionPolicyResultPayloadV1,
  toolRefusalReasonV1,
} from './permission-policy';

const base = { protocolVersion: 1 as const, sessionId: 'sess-1', requestId: 'req-1' };
const validEnvelope = {
  resourceId: 'sess-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

describe('permissionRuleSetV1', () => {
  it('parses an empty allow/deny pair', () => {
    expect(permissionRuleSetV1.parse({ allow: [], deny: [] })).toEqual({ allow: [], deny: [] });
  });

  it('trims a rule before validating it', () => {
    expect(permissionRuleSetV1.parse({ allow: ['  rm *  '], deny: [] }).allow).toEqual(['rm *']);
  });

  it('rejects a blank rule (issue #751: invalid glob rejected at entry, not at enforcement time)', () => {
    expect(() => permissionRuleSetV1.parse({ allow: [''], deny: [] })).toThrow();
    expect(() => permissionRuleSetV1.parse({ allow: ['   '], deny: [] })).toThrow();
  });
});

describe('permissionPolicyV1', () => {
  it('parses a full command+network policy', () => {
    const policy = {
      command: { allow: [], deny: ['rm -rf *'] },
      network: { allow: ['*.internal'], deny: [] },
    };
    expect(permissionPolicyV1.parse(policy)).toEqual(policy);
  });

  it('EMPTY_PERMISSION_POLICY_V1 mirrors the node-side allow-all default', () => {
    expect(EMPTY_PERMISSION_POLICY_V1).toEqual({
      command: { allow: [], deny: [] },
      network: { allow: [], deny: [] },
    });
  });
});

describe('permission_policy_get/set/result wire messages', () => {
  it('accepts every message shape', () => {
    for (const message of [
      { type: 'permission_policy_get', ...base },
      { type: 'permission_policy_set', ...base, envelope: validEnvelope },
      { type: 'permission_policy_result', ...base, envelope: validEnvelope },
    ]) {
      expect(() => wireMessageV1.parse(message)).not.toThrow();
    }
  });

  it('rejects permission_policy_set with no envelope (this policy must round-trip encrypted)', () => {
    expect(() => permissionPolicySet.parse({ type: 'permission_policy_set', ...base })).toThrow();
  });

  it('permission_policy_get carries no envelope at all', () => {
    const parsed = permissionPolicyGet.parse({ type: 'permission_policy_get', ...base });
    expect('envelope' in parsed).toBe(false);
  });

  it('permission_policy_result requires an envelope', () => {
    expect(() =>
      permissionPolicyResult.parse({ type: 'permission_policy_result', ...base }),
    ).toThrow();
    expect(() =>
      permissionPolicyResult.parse({
        type: 'permission_policy_result',
        ...base,
        envelope: validEnvelope,
      }),
    ).not.toThrow();
  });
});

describe('permission_policy_result payload', () => {
  it('parses a saved policy', () => {
    const payload = { policy: EMPTY_PERMISSION_POLICY_V1 };
    expect(parsePermissionPolicyResultPayloadV1(payload)).toEqual(payload);
  });

  it('safeParse returns a failed result on garbage rather than throwing', () => {
    const result = safeParsePermissionPolicyResultPayloadV1({ policy: 'nope' });
    expect(result.success).toBe(false);
  });
});

describe('permission_policy_set payload', () => {
  it('parses a full replacement policy', () => {
    const payload = {
      policy: { command: { allow: ['pnpm *'], deny: [] }, network: { allow: [], deny: [] } },
    };
    expect(parsePermissionPolicySetPayloadV1(payload)).toEqual(payload);
  });
});

describe('toolRefusalReasonV1 (D3-4 attribution seam, issue #751)', () => {
  it('parses the permission_policy variant', () => {
    const reason = {
      kind: 'permission_policy' as const,
      dimension: 'command' as const,
      rule: 'rm *',
      matched: 'rm -rf /',
    };
    expect(toolRefusalReasonV1.parse(reason)).toEqual(reason);
  });

  it('rejects an unknown kind — a future profile reason must add its own member, not loosen this one', () => {
    expect(() => toolRefusalReasonV1.parse({ kind: 'profile', name: 'Ask' })).toThrow();
  });
});

describe('permission_policy_violation', () => {
  it('is accepted by the discriminated union, envelope required', () => {
    const message = {
      type: 'permission_policy_violation',
      protocolVersion: 1 as const,
      sessionId: 'sess-1',
      envelope: validEnvelope,
    };
    expect(() => wireMessageV1.parse(message)).not.toThrow();
    expect(() => permissionPolicyViolation.parse({ ...message, envelope: undefined })).toThrow();
  });

  it('parses a full violation payload', () => {
    const payload = {
      reason: {
        kind: 'permission_policy' as const,
        dimension: 'network' as const,
        rule: '*.internal',
        matched: 'evil.example.com',
      },
      surface: 'terminal' as const,
      command: 'curl evil.example.com',
      timestamp: '2026-08-06T00:00:00.000Z',
    };
    expect(parsePermissionPolicyViolationPayloadV1(payload)).toEqual(payload);
  });
});
