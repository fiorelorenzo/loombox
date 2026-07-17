/**
 * QR/short-code device pairing, the fast path (SPEC §8 path 1, §16; issue
 * #113). Two devices physically together exchange P-256 public keys over an
 * out-of-band channel (a QR scan, or the short code typed manually as a
 * fallback), derive a shared secret via ECDH, and the already-trusted device
 * seals its Account Master Key for the new device over that channel — no
 * relay unwrap, no Recovery Code entry. Grounded in Happy's
 * `useConnectAccount.ts` shape (SPEC §16), reimplemented clean-room; the
 * wire messages this crypto backs (`qr_pairing_request`/`qr_pairing_response`)
 * live in `@loombox/protocol`'s `devices.ts` — this module only owns the
 * cryptography, referenced but not imported here.
 *
 * Two distinct short codes are involved, deliberately kept separate:
 *
 * - `pairingCode` — an 8-character Crockford base32 code minted with the
 *   offer. It identifies the pairing session (the QR carries it, and it is
 *   also the RFC-8628-style manual-entry fallback when scanning is not
 *   available) and is bound into the sealed AMK envelope's AAD via
 *   `envelope.ts`, exactly like every other resource id in this package.
 * - `verificationCode` — a 6-digit SAS (short authentication string),
 *   derived from both devices' public keys plus the ECDH shared secret
 *   *after* the exchange. Both devices compute and display it independently;
 *   a human compares them. If a MITM on the QR/relay channel substituted a
 *   public key on either leg, the two shared secrets differ and so does this
 *   code, catching the substitution the AAD binding alone cannot (AAD only
 *   protects the sealed envelope, not the initial key exchange).
 */
import type { EcdhKeyPair } from './ecdh';
import {
  deriveSharedSecretBits,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  importPublicKeyRaw,
} from './ecdh';
import type { Envelope } from './envelope';
import { decryptEnvelope, encryptEnvelope } from './envelope';
import { deriveChild } from './key-tree';
import { importAesGcmKey } from './aead';

/** Default pairing-offer lifetime: short-lived per SPEC §8/#113's acceptance criteria. */
export const PAIRING_DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes.

const PAIRING_CODE_BYTES = 5; // 40 bits -> exactly 8 Crockford base32 chars, no padding.
const UNCOMPRESSED_P256_POINT_BYTES = 65; // 0x04 || 32-byte X || 32-byte Y.
const QR_PAYLOAD_VERSION = 1;

// Crockford base32: digits + uppercase letters, excluding I/L/O/U to avoid
// visual confusion when a user reads the code aloud or types it by hand.
const CROCKFORD_BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Generates a fresh, human-typeable pairing/manual-entry short code. */
export function generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_BYTES));
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD_BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  return output;
}

/** The QR-encodable offer an already-trusted device displays. */
export interface PairingOffer {
  readonly pairingCode: string;
  readonly expiresAt: number; // epoch ms
  readonly existingDevicePublicKey: Uint8Array; // raw uncompressed P-256 point
}

/**
 * The already-trusted device's private-side state for one pairing offer:
 * the offer itself plus the ephemeral keypair backing it, and a `consumed`
 * flag enforcing single-use (SPEC #113's "single-use" acceptance criterion)
 * at this layer, independent of any relay-side bookkeeping.
 */
export interface PairingOfferState {
  readonly offer: PairingOffer;
  readonly keyPair: EcdhKeyPair;
  consumed: boolean;
}

/** The new device's local state after scanning/accepting an offer. */
export interface PairingAcceptance {
  readonly pairingCode: string;
  readonly newDeviceKeyPair: EcdhKeyPair;
  readonly newDevicePublicKey: Uint8Array; // raw uncompressed P-256 point
  readonly sharedSecret: Uint8Array;
  readonly verificationCode: string;
}

/** The existing device's sealed reply, ready to send back to the new device. */
export interface PairingCompletion {
  readonly pairingCode: string;
  readonly envelope: Envelope;
  readonly verificationCode: string;
}

function assertFreshOffer(offer: PairingOffer, now: number): void {
  if (now >= offer.expiresAt) {
    throw new Error('@loombox/crypto: pairing offer has expired');
  }
}

function assertMatchingPairingCode(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new Error('@loombox/crypto: pairing code does not match this pairing offer');
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.byteLength - b.byteLength;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Derives the 6-digit SAS comparison code from both raw public keys and the
 * shared secret. The two public keys are canonically ordered (lexicographic
 * byte compare) before hashing so both devices compute the identical digest
 * regardless of which side is "first" or "second" in the exchange.
 */
async function computeVerificationCode(
  publicKeyA: Uint8Array,
  publicKeyB: Uint8Array,
  sharedSecret: Uint8Array,
): Promise<string> {
  const [first, second] =
    compareBytes(publicKeyA, publicKeyB) <= 0 ? [publicKeyA, publicKeyB] : [publicKeyB, publicKeyA];
  const material = concatBytes(first, second, sharedSecret);
  // The cast is a type-only workaround for @types/node vs lib.dom.d.ts's
  // WebCrypto friction (see aead.ts's `importAesGcmKey` doc comment); no
  // runtime effect.
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', material as Uint8Array<ArrayBuffer>),
  );
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const code = view.getUint32(0, false) % 1_000_000;
  return code.toString(10).padStart(6, '0');
}

/**
 * Derives the AES-256-GCM key that seals/unwraps the AMK for this pairing,
 * from the raw ECDH shared secret via the same HMAC-SHA512 primitive
 * `key-tree.ts` uses for the AMK tree (not RFC 5869 HKDF, see that module).
 * This is a KDF step on top of the raw ECDH output (never used directly as a
 * symmetric key) and binds the derived key to `pairingCode` for domain
 * separation, on top of the AAD binding `envelope.ts` already applies.
 */
async function derivePairingAeadKey(sharedSecret: Uint8Array, pairingCode: string) {
  const { key } = deriveChild(
    sharedSecret,
    new TextEncoder().encode(`loombox-pairing-v1:${pairingCode}`),
  );
  return importAesGcmKey(key);
}

/**
 * The already-trusted device generates a pairing offer: a fresh ephemeral
 * P-256 keypair, a short-lived expiry, and a pairing/manual-entry short code
 * — everything a new device needs to fetch and unwrap the AMK (#113).
 */
export async function createPairingOffer(
  options: { readonly ttlMs?: number; readonly now?: number } = {},
): Promise<PairingOfferState> {
  const ttlMs = options.ttlMs ?? PAIRING_DEFAULT_TTL_MS;
  const now = options.now ?? Date.now();
  const keyPair = await generateEcdhKeyPair();
  const existingDevicePublicKey = await exportPublicKeyRaw(keyPair.publicKey);
  const pairingCode = generatePairingCode();
  return {
    offer: { pairingCode, expiresAt: now + ttlMs, existingDevicePublicKey },
    keyPair,
    consumed: false,
  };
}

/**
 * Packs a {@link PairingOffer} into a compact base64url string sized for a
 * QR payload: 1-byte version, 8-byte expiry, a length-prefixed pairing code,
 * then the raw 65-byte public key point — no JSON key names on the wire.
 */
export function encodePairingOfferForQr(offer: PairingOffer): string {
  const pairingCodeBytes = new TextEncoder().encode(offer.pairingCode);
  if (pairingCodeBytes.byteLength > 0xff) {
    throw new Error('@loombox/crypto: pairing code too long to encode for QR');
  }
  const buffer = new Uint8Array(
    1 + 8 + 1 + pairingCodeBytes.byteLength + offer.existingDevicePublicKey.byteLength,
  );
  const view = new DataView(buffer.buffer);
  buffer[0] = QR_PAYLOAD_VERSION;
  view.setBigUint64(1, BigInt(offer.expiresAt), false);
  buffer[9] = pairingCodeBytes.byteLength;
  buffer.set(pairingCodeBytes, 10);
  buffer.set(offer.existingDevicePublicKey, 10 + pairingCodeBytes.byteLength);
  return Buffer.from(buffer).toString('base64url');
}

/** Unpacks a {@link PairingOffer} previously encoded by {@link encodePairingOfferForQr}. */
export function decodePairingOfferFromQr(payload: string): PairingOffer {
  const buffer = new Uint8Array(Buffer.from(payload, 'base64url'));
  if (buffer.byteLength < 10) {
    throw new Error('@loombox/crypto: malformed pairing QR payload');
  }
  if (buffer[0] !== QR_PAYLOAD_VERSION) {
    throw new Error(`@loombox/crypto: unsupported pairing QR payload version ${buffer[0]}`);
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const expiresAt = Number(view.getBigUint64(1, false));
  const pairingCodeLength = buffer[9];
  const pairingCodeStart = 10;
  const pairingCodeEnd = pairingCodeStart + pairingCodeLength;
  const publicKeyEnd = pairingCodeEnd + UNCOMPRESSED_P256_POINT_BYTES;
  if (buffer.byteLength !== publicKeyEnd) {
    throw new Error('@loombox/crypto: malformed pairing QR payload');
  }
  const pairingCode = new TextDecoder().decode(buffer.subarray(pairingCodeStart, pairingCodeEnd));
  const existingDevicePublicKey = buffer.slice(pairingCodeEnd, publicKeyEnd);
  return { pairingCode, expiresAt, existingDevicePublicKey };
}

/**
 * The new device, having scanned/received an offer: generates its own P-256
 * keypair, derives the ECDH shared secret against the offer's public key,
 * and computes the SAS verification code to display for comparison. Rejects
 * an expired offer, and rejects loudly (via `importPublicKeyRaw`/
 * `deriveSharedSecretBits`) if the offer's public key was tampered with —
 * WebCrypto validates the point is actually on the P-256 curve.
 */
export async function acceptPairingOffer(
  offer: PairingOffer,
  options: { readonly now?: number } = {},
): Promise<PairingAcceptance> {
  const now = options.now ?? Date.now();
  assertFreshOffer(offer, now);

  const newDeviceKeyPair = await generateEcdhKeyPair();
  const existingDevicePublicKey = await importPublicKeyRaw(offer.existingDevicePublicKey);
  const sharedSecret = await deriveSharedSecretBits(
    newDeviceKeyPair.privateKey,
    existingDevicePublicKey,
  );
  const newDevicePublicKey = await exportPublicKeyRaw(newDeviceKeyPair.publicKey);
  const verificationCode = await computeVerificationCode(
    offer.existingDevicePublicKey,
    newDevicePublicKey,
    sharedSecret,
  );

  return {
    pairingCode: offer.pairingCode,
    newDeviceKeyPair,
    newDevicePublicKey,
    sharedSecret,
    verificationCode,
  };
}

/**
 * The already-trusted device, having received the new device's public key
 * and pairing code back (out of band, e.g. over `qr_pairing_request`): seals
 * `amk` into an AAD-bound envelope for the new device and returns the SAS
 * code to display alongside it. Enforces single-use (`state.consumed`),
 * expiry, and that `pairingCode` actually matches this offer — a wrong code
 * (typo, or a response meant for a different in-flight pairing) is rejected
 * before anything is sealed.
 */
export async function completePairing(
  state: PairingOfferState,
  newDevicePublicKey: Uint8Array,
  pairingCode: string,
  amk: Uint8Array,
  options: { readonly now?: number } = {},
): Promise<PairingCompletion> {
  const now = options.now ?? Date.now();
  if (state.consumed) {
    throw new Error('@loombox/crypto: this pairing offer has already been completed (single-use)');
  }
  assertMatchingPairingCode(state.offer.pairingCode, pairingCode);
  assertFreshOffer(state.offer, now);

  const newDeviceKey = await importPublicKeyRaw(newDevicePublicKey);
  const sharedSecret = await deriveSharedSecretBits(state.keyPair.privateKey, newDeviceKey);
  const verificationCode = await computeVerificationCode(
    state.offer.existingDevicePublicKey,
    newDevicePublicKey,
    sharedSecret,
  );

  const key = await derivePairingAeadKey(sharedSecret, pairingCode);
  const envelope = await encryptEnvelope(pairingCode, amk, key);

  state.consumed = true;
  return { pairingCode, envelope, verificationCode };
}

/**
 * The new device, having received the existing device's sealed response:
 * unwraps the AMK. Rejects loudly (the AES-GCM tag check fails) if
 * `pairingCode` doesn't match what {@link acceptPairingOffer} produced, or if
 * the envelope was tampered with in transit.
 */
export async function unwrapPairedAmk(
  acceptance: PairingAcceptance,
  pairingCode: string,
  envelope: Envelope,
): Promise<Uint8Array> {
  assertMatchingPairingCode(acceptance.pairingCode, pairingCode);
  const key = await derivePairingAeadKey(acceptance.sharedSecret, pairingCode);
  return decryptEnvelope(pairingCode, envelope, key);
}
