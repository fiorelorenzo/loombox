import { describe, expect, it } from 'vitest';
import { base64String, encryptedEnvelope, encryptionAlg } from './envelope';

describe('base64String', () => {
  it('accepts a valid base64 string', () => {
    expect(base64String.parse('aGVsbG8=')).toBe('aGVsbG8=');
  });

  it('accepts base64 with no padding needed', () => {
    expect(base64String.parse('YWJjZA==')).toBe('YWJjZA==');
    expect(base64String.parse('YWJj')).toBe('YWJj');
  });

  it('rejects a non-base64 string', () => {
    expect(() => base64String.parse('not base64!!')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => base64String.parse('')).toThrow();
  });

  it('rejects incorrectly padded base64-alphabet strings', () => {
    expect(() => base64String.parse('abcde')).toThrow();
  });

  it('rejects a non-string', () => {
    expect(() => base64String.parse(123)).toThrow();
  });
});

describe('encryptionAlg', () => {
  it('accepts the one supported algorithm literal', () => {
    expect(encryptionAlg.parse('AES-256-GCM')).toBe('AES-256-GCM');
  });

  it('rejects any other algorithm string', () => {
    expect(() => encryptionAlg.parse('AES-128-GCM')).toThrow();
  });
});

describe('encryptedEnvelope', () => {
  const valid = {
    resourceId: 'session:sess-1',
    iv: 'aGVsbG8=',
    ciphertext: 'YWJjZA==',
    alg: 'AES-256-GCM' as const,
  };

  it('round-trips a valid envelope with base64 iv/ciphertext', () => {
    expect(encryptedEnvelope.parse(valid)).toEqual(valid);
  });

  it('rejects a non-base64 iv', () => {
    expect(() => encryptedEnvelope.parse({ ...valid, iv: '!!!not-base64' })).toThrow();
  });

  it('rejects a non-base64 ciphertext', () => {
    expect(() => encryptedEnvelope.parse({ ...valid, ciphertext: 'also not base64' })).toThrow();
  });

  it('rejects a missing resourceId', () => {
    const { resourceId: _resourceId, ...rest } = valid;
    expect(() => encryptedEnvelope.parse(rest)).toThrow();
  });

  it('rejects an unsupported alg', () => {
    expect(() => encryptedEnvelope.parse({ ...valid, alg: 'ChaCha20-Poly1305' })).toThrow();
  });
});
