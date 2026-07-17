import { describe, expect, it } from 'vitest';
import { sessionUpdateEnvelopeV1 } from './transcript';

const validEnvelope = {
  resourceId: 'session:sess-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

describe('sessionUpdateEnvelopeV1', () => {
  const valid = {
    type: 'session_update',
    protocolVersion: 1,
    sessionId: 'sess-1',
    seq: 0,
    envelope: validEnvelope,
  };

  it('parses a valid session_update envelope with a monotonic seq', () => {
    expect(sessionUpdateEnvelopeV1.parse(valid)).toEqual(valid);
  });

  it('accepts an increasing seq', () => {
    expect(sessionUpdateEnvelopeV1.parse({ ...valid, seq: 41 }).seq).toBe(41);
  });

  it('rejects a negative seq', () => {
    expect(() => sessionUpdateEnvelopeV1.parse({ ...valid, seq: -1 })).toThrow();
  });

  it('rejects a non-integer seq', () => {
    expect(() => sessionUpdateEnvelopeV1.parse({ ...valid, seq: 1.5 })).toThrow();
  });

  it('rejects the wrong type discriminator', () => {
    expect(() => sessionUpdateEnvelopeV1.parse({ ...valid, type: 'prompt_inject' })).toThrow();
  });

  it('rejects a malformed envelope', () => {
    expect(() =>
      sessionUpdateEnvelopeV1.parse({ ...valid, envelope: { ...validEnvelope, ciphertext: 'x' } }),
    ).toThrow();
  });

  it('never carries decrypted transcript content as a wire field (envelope is opaque)', () => {
    const shapeKeys = Object.keys(sessionUpdateEnvelopeV1.shape);
    expect(shapeKeys).toEqual(['type', 'protocolVersion', 'sessionId', 'seq', 'envelope']);
  });
});
