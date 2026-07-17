/**
 * @loombox/crypto — E2E crypto primitives (SPEC §8, §16).
 *
 * Three layers:
 * - `ecdh.ts` / `aead.ts` / `envelope.ts`: per-device ECDH P-256 identity
 *   keys and AES-256-GCM resource-id-bound envelopes (issue #110).
 * - `key-tree.ts`: the Account Master Key and its HMAC-SHA512 BIP32-style
 *   key-tree derivation (issue #111).
 * - `pairing.ts`: QR/short-code device-to-device pairing built on the above,
 *   transferring the AMK to a new device over an ECDH-derived channel
 *   (issue #113).
 *
 * Curve decision: ECDH **P-256** via WebCrypto (SubtleCrypto), with
 * AES-256-GCM for symmetric sealing. Grounded in Nimbalyst's
 * TrackerEnvelopeCrypto / ECDHKeyManager (SPEC §16). We deliberately pick ONE
 * curve — P-256 — and do NOT blend in Happy's X25519/tweetnacl. See README.md.
 */

export type { EcdhKeyPair } from './ecdh';
export {
  deriveSharedSecretBits,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  importPublicKeyRaw,
} from './ecdh';

export type { AesGcmSealed } from './aead';
export {
  AES_GCM_IV_BYTES,
  AES_GCM_TAG_BITS,
  aesGcmDecrypt,
  aesGcmEncrypt,
  importAesGcmKey,
} from './aead';

export type { Envelope } from './envelope';
export { decryptEnvelope, encryptEnvelope } from './envelope';

export type { KeyTreeNode } from './key-tree';
export { deriveChild, deriveKeyTree, generateAmk } from './key-tree';

export type {
  PairingAcceptance,
  PairingCompletion,
  PairingOffer,
  PairingOfferState,
} from './pairing';
export {
  PAIRING_DEFAULT_TTL_MS,
  acceptPairingOffer,
  completePairing,
  createPairingOffer,
  decodePairingOfferFromQr,
  encodePairingOfferForQr,
  generatePairingCode,
  unwrapPairedAmk,
} from './pairing';

/**
 * Session-scoped key derivation + the crypto<->wire envelope bridge (SPEC
 * §8, §16). Shared here (rather than living node-local) so a node and a
 * client/PWA derive/seal/open with the exact same implementation — see
 * `session-keys.ts`/`session-envelope.ts`'s doc comments.
 */
export { deriveSessionKey } from './session-keys';
export { envelopeFromWire, envelopeToWire, openJson, sealJson } from './session-envelope';
