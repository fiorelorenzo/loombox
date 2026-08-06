import { describe, expect, it } from 'vitest';
import { wireMessageV1 } from './message';
import {
  parseSpendCapResultPayloadV1,
  parseSpendCapSetPayloadV1,
  safeParseSpendCapResultPayloadV1,
  safeParseSpendCapSetPayloadV1,
  sessionSpendCapResume,
  spendCapGet,
  spendCapResult,
  spendCapSet,
} from './spend-cap';

const base = { protocolVersion: 1 as const, sessionId: 'sess-1', requestId: 'req-1' };
const validEnvelope = {
  resourceId: 'sess-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

describe('spend_cap_get/set/result wire messages', () => {
  it('accepts every message shape', () => {
    for (const message of [
      { type: 'spend_cap_get', ...base },
      { type: 'spend_cap_set', ...base, envelope: validEnvelope },
      { type: 'spend_cap_result', ...base, envelope: validEnvelope },
      { type: 'session_spend_cap_resume', protocolVersion: 1 as const, sessionId: 'sess-1' },
    ]) {
      expect(() => wireMessageV1.parse(message)).not.toThrow();
    }
  });

  it('rejects spend_cap_set with no envelope (a dollar figure round-trips encrypted, mirrors permission_policy_set)', () => {
    expect(() => spendCapSet.parse({ type: 'spend_cap_set', ...base })).toThrow();
  });

  it('spend_cap_get carries no envelope at all', () => {
    const parsed = spendCapGet.parse({ type: 'spend_cap_get', ...base });
    expect('envelope' in parsed).toBe(false);
  });

  it('spend_cap_result requires an envelope', () => {
    expect(() => spendCapResult.parse({ type: 'spend_cap_result', ...base })).toThrow();
    expect(() =>
      spendCapResult.parse({ type: 'spend_cap_result', ...base, envelope: validEnvelope }),
    ).not.toThrow();
  });

  it('session_spend_cap_resume carries neither an envelope nor a requestId — resuming has no content, mirrors run_cancel', () => {
    const parsed = sessionSpendCapResume.parse({
      type: 'session_spend_cap_resume',
      protocolVersion: 1,
      sessionId: 'sess-1',
    });
    expect('envelope' in parsed).toBe(false);
    expect('requestId' in parsed).toBe(false);
  });
});

describe('spend_cap_set payload', () => {
  it('parses a positive project or session cap', () => {
    expect(parseSpendCapSetPayloadV1({ scope: 'project', capUsd: 25 })).toEqual({
      scope: 'project',
      capUsd: 25,
    });
    expect(parseSpendCapSetPayloadV1({ scope: 'session', capUsd: 5.5 })).toEqual({
      scope: 'session',
      capUsd: 5.5,
    });
  });

  it('parses capUsd: null as an explicit clear', () => {
    expect(parseSpendCapSetPayloadV1({ scope: 'project', capUsd: null })).toEqual({
      scope: 'project',
      capUsd: null,
    });
  });

  it('rejects a zero or negative cap — a spend cap of $0 is not a real limit', () => {
    expect(safeParseSpendCapSetPayloadV1({ scope: 'project', capUsd: 0 }).success).toBe(false);
    expect(safeParseSpendCapSetPayloadV1({ scope: 'session', capUsd: -5 }).success).toBe(false);
  });

  it('rejects an unknown scope', () => {
    expect(safeParseSpendCapSetPayloadV1({ scope: 'account', capUsd: 5 }).success).toBe(false);
  });
});

describe('spend_cap_result payload', () => {
  it('parses both scopes set', () => {
    const payload = { projectCapUsd: 100, sessionCapUsd: 20 };
    expect(parseSpendCapResultPayloadV1(payload)).toEqual(payload);
  });

  it('parses neither scope set — null, never a fabricated 0', () => {
    const payload = { projectCapUsd: null, sessionCapUsd: null };
    expect(parseSpendCapResultPayloadV1(payload)).toEqual(payload);
  });

  it('safeParse returns a failed result on garbage rather than throwing', () => {
    expect(safeParseSpendCapResultPayloadV1({ projectCapUsd: 'nope' }).success).toBe(false);
  });
});
