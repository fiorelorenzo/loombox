/**
 * AAD-bound sealed envelopes (SPEC §8, §16). This is Nimbalyst's documented
 * fix for a swap/spoof hole: binding the ciphertext's AAD to the resource id
 * it belongs to, so an envelope moved or relabeled onto a different resource
 * fails to decrypt instead of silently opening under the wrong context.
 */
import type { CryptoKey } from './webcrypto-types';
import { aesGcmDecrypt, aesGcmEncrypt } from './aead';

/** A sealed envelope whose ciphertext is bound to `resourceId` via AAD. */
export interface Envelope {
  readonly resourceId: string;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
}

const resourceIdToAad = (resourceId: string): Uint8Array => new TextEncoder().encode(resourceId);

/** Encrypts `plaintext` under `key`, binding the ciphertext to `resourceId`. */
export async function encryptEnvelope(
  resourceId: string,
  plaintext: Uint8Array,
  key: CryptoKey,
): Promise<Envelope> {
  const { iv, ciphertext } = await aesGcmEncrypt(key, plaintext, resourceIdToAad(resourceId));
  return { resourceId, iv, ciphertext };
}

/**
 * Decrypts `envelope` under `key`, requiring it to have been sealed for
 * `resourceId`. `resourceId` here is the caller's own, independently-known
 * expected id (e.g. the id of the row/path the envelope was just fetched
 * from) — not read back off `envelope.resourceId`, since an attacker could
 * relabel that field too. If the envelope was actually sealed for a
 * different resource id, the AAD check fails and this rejects loudly.
 */
export async function decryptEnvelope(
  resourceId: string,
  envelope: Envelope,
  key: CryptoKey,
): Promise<Uint8Array> {
  return aesGcmDecrypt(key, envelope.iv, envelope.ciphertext, resourceIdToAad(resourceId));
}
