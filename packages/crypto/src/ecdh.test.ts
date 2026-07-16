import { describe, expect, it } from 'vitest';
import {
  deriveSharedSecretBits,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  importPublicKeyRaw,
} from './ecdh';

describe('ecdh (P-256 via WebCrypto)', () => {
  it('generates a P-256 keypair', async () => {
    const keyPair = await generateEcdhKeyPair();
    expect(keyPair.publicKey.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' });
    expect(keyPair.privateKey.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' });
    expect(keyPair.publicKey.type).toBe('public');
    expect(keyPair.privateKey.type).toBe('private');
  });

  it('round-trips a public key through raw export/import', async () => {
    const keyPair = await generateEcdhKeyPair();
    const raw = await exportPublicKeyRaw(keyPair.publicKey);
    // Uncompressed P-256 point: 0x04 prefix + 32-byte X + 32-byte Y.
    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(0x04);

    const imported = await importPublicKeyRaw(raw);
    const reRaw = await exportPublicKeyRaw(imported);
    expect(reRaw).toEqual(raw);
  });

  it('two devices derive the same ECDH shared secret from each other', async () => {
    const alice = await generateEcdhKeyPair();
    const bob = await generateEcdhKeyPair();

    const aliceSecret = await deriveSharedSecretBits(alice.privateKey, bob.publicKey);
    const bobSecret = await deriveSharedSecretBits(bob.privateKey, alice.publicKey);

    expect(aliceSecret).toEqual(bobSecret);
    expect(aliceSecret).toHaveLength(32); // 256 bits
  });

  it('produces an independent shared secret for an unrelated keypair', async () => {
    const alice = await generateEcdhKeyPair();
    const bob = await generateEcdhKeyPair();
    const mallory = await generateEcdhKeyPair();

    const aliceBob = await deriveSharedSecretBits(alice.privateKey, bob.publicKey);
    const aliceMallory = await deriveSharedSecretBits(alice.privateKey, mallory.publicKey);

    expect(aliceBob).not.toEqual(aliceMallory);
  });

  it('imports a raw public key exported from a different keypair without cross-contamination', async () => {
    const alice = await generateEcdhKeyPair();
    const bob = await generateEcdhKeyPair();

    const bobRaw = await exportPublicKeyRaw(bob.publicKey);
    const bobImported = await importPublicKeyRaw(bobRaw);

    const direct = await deriveSharedSecretBits(alice.privateKey, bob.publicKey);
    const viaImport = await deriveSharedSecretBits(alice.privateKey, bobImported);

    expect(direct).toEqual(viaImport);
  });
});
