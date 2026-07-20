/**
 * Recovery-code AMK escrow (SPEC §8 path 2 "Recovery-code escrow", §16;
 * issues #114/#115). This is loombox's default "no device to scan from"
 * bootstrap path: a high-entropy, human-transcribable Recovery Code wraps
 * the Account Master Key so it can be uploaded to the relay as opaque
 * ciphertext and later recovered by a brand-new device that only has OAuth
 * identity plus the code — no other device needs to be online.
 *
 * Grounded in Signal's PIN + Secure Value Recovery precedent (SPEC §16:
 * "a server-escrowed, guess-limited encrypted key blob"), adapted here to a
 * high-entropy generated code so no enclave-based guess limiter is
 * required — the code itself carries enough entropy that offline brute
 * force against the escrowed ciphertext is infeasible. Formatting mirrors
 * 1Password's secret-key legibility convention (`secretKeyBackup.ts:81-102`,
 * `formatSecretKeyForBackup`): Crockford base32 (excludes I/L/O/U to avoid
 * visual confusion), dash-grouped.
 *
 * Built entirely on WebCrypto (`crypto.subtle`), matching every other
 * module in this package (see `key-tree.ts`'s doc comment on why: Vite
 * externalizes Node's `crypto` builtin for the browser build, so this must
 * never import it). `btoa`/`atob` (not `Buffer`) do the wire-blob base64
 * encoding for the same reason — see `amk-store.ts` in `apps/web` for the
 * identical rationale/pattern this mirrors.
 */
import { aesGcmDecrypt, aesGcmEncrypt, AES_GCM_IV_BYTES, importAesGcmKey } from './aead';

/** 160 bits of CSPRNG entropy per Recovery Code — comfortably beyond brute-force reach with no server-side rate limiter (SPEC §16: "adapted... so no enclave-based rate limiter is required"). */
export const RECOVERY_CODE_BYTES = 20;
/** Dash-grouping width for {@link formatRecoveryCodeForDisplay} — 20 bytes of Crockford base32 is exactly 32 characters (160 / 5), so this divides evenly into 8 groups of 4. */
export const RECOVERY_CODE_GROUP_SIZE = 4;
/** Random per-escrow salt length, fed into the PBKDF2 wrapping-key derivation alongside the Recovery Code. */
export const RECOVERY_SALT_BYTES = 16;
/** PBKDF2-HMAC-SHA256 iteration count — OWASP's 2023 baseline for this hash. There is no server-side guess limiter (the code itself is the defense), so this is the only cost factor standing between a stolen escrow blob and the AMK. */
export const RECOVERY_PBKDF2_ITERATIONS = 210_000;

const PBKDF2_HASH = 'SHA-256';
const WRAPPED_AMK_WIRE_FORMAT_VERSION = 1;

// Matches pairing.ts's alphabet (digits + uppercase, excluding I/L/O/U) —
// kept as a local copy rather than a shared import so this module has no
// dependency on the QR-pairing-specific `pairing.ts` (different feature,
// same well-known alphabet).
const CROCKFORD_BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function crockfordBase32Encode(bytes: Uint8Array): string {
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

/** Groups a raw (undashed) code into legible chunks, e.g. `XXXX-XXXX-...` (1Password-secret-key-style). */
export function formatRecoveryCodeForDisplay(
  rawCode: string,
  groupSize: number = RECOVERY_CODE_GROUP_SIZE,
): string {
  const groups: string[] = [];
  for (let i = 0; i < rawCode.length; i += groupSize) {
    groups.push(rawCode.slice(i, i + groupSize));
  }
  return groups.join('-');
}

/**
 * Normalizes user-entered Recovery Code input for KDF use: uppercases and
 * strips everything that isn't a valid Crockford base32 character (dashes,
 * whitespace, any typo'd punctuation) — forgiving of exactly how the code
 * was transcribed, without changing what it derives to.
 */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '');
}

/** Generates a fresh Recovery Code: {@link RECOVERY_CODE_BYTES} of CSPRNG entropy, formatted for display. */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES));
  return formatRecoveryCodeForDisplay(crockfordBase32Encode(bytes));
}

async function pbkdf2DeriveBits(
  passwordBytes: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  lengthBits: number,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    passwordBytes as Uint8Array<ArrayBuffer>,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as Uint8Array<ArrayBuffer>,
      iterations,
      hash: PBKDF2_HASH,
    },
    baseKey,
    lengthBits,
  );
  return new Uint8Array(bits);
}

/**
 * Derives the raw 256-bit wrapping-key material for a (Recovery Code, salt)
 * pair via PBKDF2-HMAC-SHA256 — a vetted KDF, not a bespoke construction.
 * Deterministic: the same (code, salt) always derives the same bytes (the
 * KAT this module's tests assert directly). Exported separately from
 * {@link wrapAmkWithRecoveryCode}/{@link unwrapAmkWithRecoveryCode} so tests
 * can assert on the derived bytes themselves, not just on wrap/unwrap
 * behavior.
 */
export async function deriveRecoveryWrapKeyBits(
  recoveryCode: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const normalized = normalizeRecoveryCode(recoveryCode);
  return pbkdf2DeriveBits(
    new TextEncoder().encode(normalized),
    salt,
    RECOVERY_PBKDF2_ITERATIONS,
    256,
  );
}

async function deriveRecoveryWrapKey(recoveryCode: string, salt: Uint8Array) {
  const bits = await deriveRecoveryWrapKeyBits(recoveryCode, salt);
  return importAesGcmKey(bits);
}

/** The wrapped-AMK ciphertext plus the salt needed to re-derive its wrapping key — everything {@link unwrapAmkWithRecoveryCode} needs, and nothing else (no AMK, no Recovery Code). */
export interface WrappedAmkBlob {
  readonly salt: Uint8Array;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/**
 * Wraps `amk` under a key derived from `recoveryCode` plus a fresh random
 * salt, AES-256-GCM-sealed with the AAD bound to `accountId` (mirrors
 * `envelope.ts`'s resource-id binding: an escrow blob sealed for one
 * account fails to unwrap if ever presented for another, in addition to the
 * relay's own account-scoped storage — defense in depth, not the only
 * check).
 */
export async function wrapAmkWithRecoveryCode(
  amk: Uint8Array,
  recoveryCode: string,
  accountId: string,
): Promise<WrappedAmkBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(RECOVERY_SALT_BYTES));
  const key = await deriveRecoveryWrapKey(recoveryCode, salt);
  const { iv, ciphertext } = await aesGcmEncrypt(key, amk, new TextEncoder().encode(accountId));
  return { salt, iv, ciphertext };
}

/**
 * Inverse of {@link wrapAmkWithRecoveryCode}. Rejects (the AES-GCM auth tag
 * check fails) if `recoveryCode` or `accountId` is wrong, or if `blob` was
 * tampered with — this is what makes "wrong code" fail loudly instead of
 * silently returning garbage key bytes.
 */
export async function unwrapAmkWithRecoveryCode(
  blob: WrappedAmkBlob,
  recoveryCode: string,
  accountId: string,
): Promise<Uint8Array> {
  const key = await deriveRecoveryWrapKey(recoveryCode, blob.salt);
  return aesGcmDecrypt(key, blob.iv, blob.ciphertext, new TextEncoder().encode(accountId));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Packs a {@link WrappedAmkBlob} into the single opaque base64 string the
 * wire's `amk_escrow`/`new_device_bootstrap_response` `wrappedAmk` field
 * carries (`@loombox/protocol`'s `devices.ts`: "the relay stores
 * `wrappedAmk` as an opaque base64 blob; it never learns the AMK or the
 * Recovery Code that wraps it"). Layout: 1-byte format version, 1-byte salt
 * length, the salt, {@link AES_GCM_IV_BYTES} bytes of IV, then the rest is
 * ciphertext — everything the relay ever sees is exactly this opaque byte
 * string, never parsed or decrypted by it.
 */
export function packWrappedAmkForWire(blob: WrappedAmkBlob): string {
  if (blob.salt.byteLength > 0xff) {
    throw new Error('@loombox/crypto: recovery salt too long to pack for the wire');
  }
  const bytes = new Uint8Array(
    2 + blob.salt.byteLength + AES_GCM_IV_BYTES + blob.ciphertext.byteLength,
  );
  let offset = 0;
  bytes[offset] = WRAPPED_AMK_WIRE_FORMAT_VERSION;
  offset += 1;
  bytes[offset] = blob.salt.byteLength;
  offset += 1;
  bytes.set(blob.salt, offset);
  offset += blob.salt.byteLength;
  bytes.set(blob.iv, offset);
  offset += blob.iv.byteLength;
  bytes.set(blob.ciphertext, offset);
  return toBase64(bytes);
}

/** Inverse of {@link packWrappedAmkForWire}. Throws on a malformed or unsupported-version blob. */
export function unpackWrappedAmkFromWire(wire: string): WrappedAmkBlob {
  const bytes = fromBase64(wire);
  if (bytes.byteLength < 2) {
    throw new Error('@loombox/crypto: malformed wrapped-AMK blob');
  }
  if (bytes[0] !== WRAPPED_AMK_WIRE_FORMAT_VERSION) {
    throw new Error(`@loombox/crypto: unsupported wrapped-AMK blob version ${bytes[0]}`);
  }
  const saltLength = bytes[1];
  const saltStart = 2;
  const ivStart = saltStart + saltLength;
  const ciphertextStart = ivStart + AES_GCM_IV_BYTES;
  if (bytes.byteLength < ciphertextStart) {
    throw new Error('@loombox/crypto: malformed wrapped-AMK blob');
  }
  return {
    salt: bytes.slice(saltStart, ivStart),
    iv: bytes.slice(ivStart, ciphertextStart),
    ciphertext: bytes.slice(ciphertextStart),
  };
}
