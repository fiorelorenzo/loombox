import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { verifySupervisorArtifact } from './supervisor-artifact';

/** Generates a real Ed25519 keypair and returns the raw 32-byte public key alongside the signing `KeyObject` — the same shape a real minisign-style release-signing step would produce (SPEC §16). */
function generateEd25519Pair(): { privateKey: KeyObject; publicKeyRaw: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKeyRaw: new Uint8Array(Buffer.from(jwk.x, 'base64url')) };
}

function sign(bytes: Uint8Array, privateKey: KeyObject): Uint8Array {
  return new Uint8Array(cryptoSign(null, Buffer.from(bytes), privateKey));
}

describe('verifySupervisorArtifact', () => {
  it('accepts an artifact whose signature matches the pinned public key', () => {
    const { privateKey, publicKeyRaw } = generateEd25519Pair();
    const bytes = new TextEncoder().encode('supervisor-runtime-v1');
    const signature = sign(bytes, privateKey);

    expect(verifySupervisorArtifact({ bytes, signature }, publicKeyRaw)).toEqual({ ok: true });
  });

  it('refuses a tampered artifact whose bytes no longer match the signature (covers "checksum-mismatched")', () => {
    const { privateKey, publicKeyRaw } = generateEd25519Pair();
    const bytes = new TextEncoder().encode('supervisor-runtime-v1');
    const signature = sign(bytes, privateKey);
    const tampered = new TextEncoder().encode('supervisor-runtime-v1-tampered');

    const result = verifySupervisorArtifact({ bytes: tampered, signature }, publicKeyRaw);
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_signature',
      message: expect.stringMatching(/signature/i),
    });
  });

  it('refuses an artifact signed by a different key than the one pinned', () => {
    const attacker = generateEd25519Pair();
    const { publicKeyRaw: pinnedPublicKey } = generateEd25519Pair();
    const bytes = new TextEncoder().encode('supervisor-runtime-v1');
    const signature = sign(bytes, attacker.privateKey);

    const result = verifySupervisorArtifact({ bytes, signature }, pinnedPublicKey);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid_signature');
  });

  it('refuses an artifact with no signature at all, distinctly from an invalid one', () => {
    const { publicKeyRaw } = generateEd25519Pair();
    const bytes = new TextEncoder().encode('supervisor-runtime-v1');

    const result = verifySupervisorArtifact({ bytes, signature: undefined }, publicKeyRaw);
    expect(result).toEqual({
      ok: false,
      reason: 'missing_signature',
      message: expect.stringMatching(/no signature/i),
    });
  });

  it('refuses an artifact with an empty signature buffer the same way as a missing one', () => {
    const { publicKeyRaw } = generateEd25519Pair();
    const bytes = new TextEncoder().encode('supervisor-runtime-v1');

    const result = verifySupervisorArtifact({ bytes, signature: new Uint8Array(0) }, publicKeyRaw);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('missing_signature');
  });
});
