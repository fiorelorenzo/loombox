/**
 * Per-device ECDH P-256 keypairs (SPEC §8, §16). Grounded in Nimbalyst's
 * `ECDHKeyManager.ts` shape (P-256 via WebCrypto), reimplemented clean-room.
 *
 * One curve only: P-256. Do not blend in Happy's X25519/tweetnacl — see the
 * package README for the recorded decision.
 */
import type { webcrypto } from 'node:crypto';

type CryptoKey = webcrypto.CryptoKey;

const ECDH_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** A device's ECDH P-256 identity keypair. */
export interface EcdhKeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

/** Generates a fresh, non-extractable-by-default-safe ECDH P-256 keypair. */
export async function generateEcdhKeyPair(): Promise<EcdhKeyPair> {
  const keyPair = await crypto.subtle.generateKey(ECDH_ALGORITHM, true, [
    'deriveBits',
    'deriveKey',
  ]);
  return keyPair as EcdhKeyPair;
}

/**
 * Exports a public key as a raw uncompressed EC point (0x04 || X || Y, 65
 * bytes for P-256) — the compact wire format for handing a device's public
 * key to a peer or the relay's device registry.
 */
export async function exportPublicKeyRaw(publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
}

/** Imports a public key previously exported via {@link exportPublicKeyRaw}. */
export async function importPublicKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  // The cast is a type-only workaround for a known friction point between
  // @types/node's `Uint8Array<ArrayBufferLike>` and lib.dom.d.ts's WebCrypto
  // methods (see aead.ts's `importAesGcmKey` doc comment); no runtime effect.
  return crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, ECDH_ALGORITHM, true, []);
}

/**
 * Derives the raw ECDH shared-secret bits between one side's private key and
 * the other side's public key (symmetric: either side calling this with the
 * other's public key derives the same bytes). Callers that need an AES-GCM
 * key from this should feed the result into {@link importAesGcmKey} — kept
 * separate so the raw shared secret can also seed the AMK key tree.
 */
export async function deriveSharedSecretBits(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  lengthBits = 256,
): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    lengthBits,
  );
  return new Uint8Array(bits);
}
