/**
 * AES-256-GCM symmetric sealing (SPEC §8, §10, §16) via WebCrypto. Every
 * call takes an explicit AAD — callers are the envelope layer (`envelope.ts`)
 * binding ciphertext to a resource id, and key-wrap call sites binding
 * ciphertext to a device id.
 */
import type { webcrypto } from 'node:crypto';

type CryptoKey = webcrypto.CryptoKey;

const AES_GCM_KEY_LENGTH_BITS = 256;
export const AES_GCM_IV_BYTES = 12; // 96-bit IV, the WebCrypto/NIST-recommended size.
export const AES_GCM_TAG_BITS = 128;

/** A sealed AES-256-GCM output: the random IV and the ciphertext (tag appended). */
export interface AesGcmSealed {
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/** Imports 32 bytes of raw key material as a non-extractable AES-256-GCM key. */
export async function importAesGcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.byteLength !== 32) {
    throw new Error(`@loombox/crypto: AES-256-GCM key must be 32 bytes, got ${rawKey.byteLength}`);
  }
  return crypto.subtle.importKey(
    'raw',
    // The cast is a type-only workaround for a known friction point between
    // @types/node's `Uint8Array<ArrayBufferLike>` and lib.dom.d.ts's WebCrypto
    // methods, which require the narrower `Uint8Array<ArrayBuffer>`, when a
    // consumer's tsconfig includes both (e.g. apps/web's browser + Node types
    // combo) — no runtime effect, WebCrypto accepts any `ArrayBufferView`.
    rawKey as Uint8Array<ArrayBuffer>,
    { name: 'AES-GCM', length: AES_GCM_KEY_LENGTH_BITS },
    true,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypts `plaintext` under `key`, binding `aad` (additional authenticated
 * data) into the GCM tag. A caller may pass an explicit `iv` for known-answer
 * testing; production call sites should omit it and get a fresh random IV.
 */
export async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
  iv: Uint8Array = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES)),
): Promise<AesGcmSealed> {
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as Uint8Array<ArrayBuffer>,
      additionalData: aad as Uint8Array<ArrayBuffer>,
      tagLength: AES_GCM_TAG_BITS,
    },
    key,
    plaintext as Uint8Array<ArrayBuffer>,
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/**
 * Decrypts `ciphertext` under `key`, verifying it was sealed with this exact
 * `aad`. WebCrypto rejects the promise (tag/AAD mismatch) if `aad` does not
 * match what was used at seal time or if `ciphertext` was tampered with —
 * this is what makes envelope resource-id binding fail loudly on a swap.
 */
export async function aesGcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv as Uint8Array<ArrayBuffer>,
      additionalData: aad as Uint8Array<ArrayBuffer>,
      tagLength: AES_GCM_TAG_BITS,
    },
    key,
    ciphertext as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(plaintext);
}
