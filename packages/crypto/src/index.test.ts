import { describe, expect, it } from 'vitest';
import { decryptEnvelope, deriveKey, encryptEnvelope, wrapKey } from './index';

describe('@loombox/crypto bootstrap', () => {
  it('exposes throwing stubs until the real implementation lands', () => {
    expect(() => deriveKey()).toThrow(/not implemented/);
    expect(() => wrapKey()).toThrow(/not implemented/);
    expect(() => encryptEnvelope()).toThrow(/not implemented/);
    expect(() => decryptEnvelope()).toThrow(/not implemented/);
  });
});
