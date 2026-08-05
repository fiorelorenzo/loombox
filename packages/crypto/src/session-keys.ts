import type { CryptoKey } from './webcrypto-types';
import { deriveKeyTree } from './key-tree';
import { importAesGcmKey } from './aead';

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
  const node = await deriveKeyTree(amk, ['session', accountId, sessionId]);
  return importAesGcmKey(node.key);
}

/**
 * Derives one project's symmetric AES-256-GCM key from the account's Account
 * Master Key via this package's HMAC-SHA512 key tree (SPEC §8, §16) — the
 * second resource-key family, alongside {@link deriveSessionKey} above.
 *
 * Documented derivation path: `['project', accountId, projectPath]`, the
 * shape `deriveSessionKey`'s own doc comment anticipates when it explains why
 * the leading segment exists ("so it can never collide with another family
 * derived from the same AMK").
 *
 * This family exists because some content is a property of a **project**, not
 * of any one session (issue #697): a project's tracker records are the first
 * such content. Sealing them to a session key made them unreadable whenever
 * that session was not running, which is most of the time — and it is the
 * wrong scope besides, since the records outlive every session that ever read
 * them. `projectPath` is the same identity the node already keys its
 * per-project state by (`TrackerModeStore`, `AccountPinStore`), so a project
 * has exactly one key no matter which session, device or node reaches it.
 *
 * Note what this does NOT do: it does not make the relay able to read
 * anything. Both a node and a client derive this locally from the AMK they
 * already hold, so a project-scoped request is still opaque ciphertext in
 * transit, exactly like a session-scoped one.
 */
export async function deriveProjectKey(
  amk: Uint8Array,
  accountId: string,
  projectPath: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['project', accountId, projectPath]);
  return importAesGcmKey(node.key);
}
