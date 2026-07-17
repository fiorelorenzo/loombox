import type { webcrypto } from 'node:crypto';
import { deriveKeyTree, importAesGcmKey } from '@loombox/crypto';

type CryptoKey = webcrypto.CryptoKey;

/**
 * Derives one session's symmetric AES-256-GCM key from the account's Account
 * Master Key via `@loombox/crypto`'s HMAC-SHA512 key tree (SPEC §8, §16).
 *
 * Documented derivation path: `['session', accountId, sessionId]`.
 * - The `'session'` segment namespaces this resource-key family so it can
 *   never collide with another family derived from the same AMK (e.g. a
 *   future device-wrap key under `['device', deviceId]`).
 * - `accountId` then `sessionId` scope the key per-account and per-session,
 *   so two sessions never share a key even though every session on the
 *   account is derived from the same one AMK.
 *
 * This is the whole point of a key tree (`packages/crypto/src/key-tree.ts`'s
 * doc comment): any device holding the account's AMK derives this exact key
 * with no other device online and no relay round trip — the node derives it
 * here to encrypt outgoing session updates and decrypt inbound prompts; a
 * client (PWA/phone) derives the identical key independently, from the same
 * AMK and the same path, to decrypt/encrypt on its side.
 */
export async function deriveSessionKey(
  amk: Uint8Array,
  accountId: string,
  sessionId: string,
): Promise<CryptoKey> {
  const node = deriveKeyTree(amk, ['session', accountId, sessionId]);
  return importAesGcmKey(node.key);
}
