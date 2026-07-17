import type { webcrypto } from 'node:crypto';
import { deriveKeyTree } from './key-tree';
import { importAesGcmKey } from './aead';

type CryptoKey = webcrypto.CryptoKey;

/**
 * Derives one session's symmetric AES-256-GCM key from the account's Account
 * Master Key via this package's HMAC-SHA512 key tree (SPEC §8, §16).
 *
 * Documented derivation path: `['session', accountId, sessionId]`.
 * - The `'session'` segment namespaces this resource-key family so it can
 *   never collide with another family derived from the same AMK (e.g. a
 *   future device-wrap key under `['device', deviceId]`).
 * - `accountId` then `sessionId` scope the key per-account and per-session,
 *   so two sessions never share a key even though every session on the
 *   account is derived from the same one AMK.
 *
 * This is the whole point of a key tree (`key-tree.ts`'s doc comment): any
 * device holding the account's AMK derives this exact key with no other
 * device online and no relay round trip. Lives in `@loombox/crypto` (not
 * `@loombox/node`) precisely so both a node (encrypting outgoing session
 * updates, decrypting inbound prompts) and a client/PWA (decrypting session
 * updates, encrypting outgoing prompts) import the identical implementation
 * rather than two copies that could drift apart — the whole point of the
 * shared-crypto move is that both sides provably derive the same key.
 */
export async function deriveSessionKey(
  amk: Uint8Array,
  accountId: string,
  sessionId: string,
): Promise<CryptoKey> {
  const node = deriveKeyTree(amk, ['session', accountId, sessionId]);
  return importAesGcmKey(node.key);
}
