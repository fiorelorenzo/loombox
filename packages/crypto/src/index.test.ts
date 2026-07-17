import { describe, expect, it } from 'vitest';
import {
  decryptEnvelope,
  deriveChild,
  deriveKeyTree,
  deriveSharedSecretBits,
  encryptEnvelope,
  generateAmk,
  generateEcdhKeyPair,
  importAesGcmKey,
} from './index';

describe('@loombox/crypto public API', () => {
  it('re-exports the ECDH, envelope, and key-tree primitives from a single entrypoint', () => {
    expect(typeof generateEcdhKeyPair).toBe('function');
    expect(typeof deriveSharedSecretBits).toBe('function');
    expect(typeof importAesGcmKey).toBe('function');
    expect(typeof encryptEnvelope).toBe('function');
    expect(typeof decryptEnvelope).toBe('function');
    expect(typeof generateAmk).toBe('function');
    expect(typeof deriveChild).toBe('function');
    expect(typeof deriveKeyTree).toBe('function');
  });

  it('supports the end-to-end flow: derive a session key from the AMK and seal a resource', async () => {
    const amk = generateAmk();
    const sessionNode = await deriveKeyTree(amk, ['session', 'session-1']);
    const key = await importAesGcmKey(sessionNode.key);

    const plaintext = new TextEncoder().encode('agent turn output');
    const envelope = await encryptEnvelope('session-1', plaintext, key);
    const decrypted = await decryptEnvelope('session-1', envelope, key);

    expect(decrypted).toEqual(plaintext);
  });
});
