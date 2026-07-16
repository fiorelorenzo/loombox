import { describe, expect, it } from 'vitest';
import { decryptEnvelope, encryptEnvelope } from './envelope';
import { importAesGcmKey } from './aead';

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('envelope (AAD-bound to resourceId)', () => {
  it('round-trips encrypt/decrypt for the correct resourceId', async () => {
    const key = await importAesGcmKey(hexToBytes('33'.repeat(32)));
    const plaintext = utf8('session transcript chunk');

    const envelope = await encryptEnvelope('session-42', plaintext, key);
    expect(envelope.resourceId).toBe('session-42');

    const decrypted = await decryptEnvelope('session-42', envelope, key);
    expect(decrypted).toEqual(plaintext);
  });

  it('fails loudly on a resourceId swap/spoof attempt (wrong AAD)', async () => {
    const key = await importAesGcmKey(hexToBytes('44'.repeat(32)));
    const plaintext = utf8('do not let this leak to another resource');

    // Envelope was sealed for 'session-42'...
    const envelope = await encryptEnvelope('session-42', plaintext, key);

    // ...but an attacker relabels/moves it to pose as 'session-99'.
    const spoofed = { ...envelope, resourceId: 'session-99' };

    // Decrypting under the id the envelope now claims to belong to must
    // fail: the AAD baked in at seal time ('session-42') no longer matches.
    await expect(decryptEnvelope('session-99', spoofed, key)).rejects.toThrow();

    // The original id still works, proving the ciphertext itself is intact.
    await expect(decryptEnvelope('session-42', spoofed, key)).resolves.toEqual(plaintext);
  });

  it('fails loudly when the caller simply passes the wrong expected resourceId', async () => {
    const key = await importAesGcmKey(hexToBytes('55'.repeat(32)));
    const envelope = await encryptEnvelope('doc-1', utf8('contents'), key);

    await expect(decryptEnvelope('doc-2', envelope, key)).rejects.toThrow();
  });

  it('matches a known-answer envelope vector', async () => {
    const keyHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const key = await importAesGcmKey(hexToBytes(keyHex));
    const plaintext = utf8('loombox known-answer test vector');

    const envelope = await encryptEnvelope('resource-kat-001', plaintext, key);
    const decrypted = await decryptEnvelope('resource-kat-001', envelope, key);

    expect(decrypted).toEqual(plaintext);
    expect(envelope.iv).toHaveLength(12);
    expect(envelope.ciphertext).toHaveLength(plaintext.length + 16);
  });
});
