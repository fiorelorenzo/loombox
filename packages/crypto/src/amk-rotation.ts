/**
 * AMK epoch rotation for device revocation (SPEC §8, §16; issue #116).
 * Escrow (#114/#115, `recovery-escrow.ts`) is the wrap pattern this reuses,
 * but revocation's wrap target is a *device's already-known ECDH public key*
 * rather than a Recovery Code, exactly like QR pairing (`pairing.ts`). The
 * difference from pairing: this is non-interactive (the acting device
 * already knows every surviving device's public key from the registry, no
 * offer/accept round trip) and it wraps a **freshly-minted** AMK epoch, not
 * the account's existing one.
 *
 * SPEC §8: "the acting (already-unlocked, online) device mints a new AMK
 * epoch from fresh random entropy (not derivable from the old AMK...) and
 * ECDH-wraps that new epoch for each other currently registered device's
 * already-known public key." {@link generateAmkEpoch} is the mint step —
 * plain fresh CSPRNG output, exactly like {@link generateAmk}, so it has no
 * mathematical relationship to whatever AMK came before it; a revoked device
 * holding only the old AMK has no key-tree path that reaches the new one.
 */
import { deriveSharedSecretBits, importPublicKeyRaw } from './ecdh';
import type { CryptoKey } from './webcrypto-types';
import type { Envelope } from './envelope';
import { decryptEnvelope, encryptEnvelope } from './envelope';
import { deriveChild, generateAmk } from './key-tree';
import { importAesGcmKey } from './aead';

/**
 * Mints a fresh AMK epoch: {@link generateAmk}'s own fresh-CSPRNG output,
 * re-exported under a revocation-specific name for call-site clarity (this
 * is *not* derived from the account's current AMK — see the module doc
 * comment's "not derivable from the old AMK" test).
 */
export function generateAmkEpoch(): Uint8Array {
  return generateAmk();
}

/**
 * The AAD-binding resource id for one device's rewrapped-AMK-epoch envelope:
 * `accountId` + `deviceId` + `epoch`, exactly as issue #116 specifies. Binds
 * the ciphertext to the exact (account, device, epoch) triple it was sealed
 * for — an envelope minted for one device/epoch fails to decrypt if presented
 * for another device, another epoch, or another account (the same swap/spoof
 * fix `envelope.ts`'s doc comment describes, applied here on top of the
 * per-device ECDH channel itself).
 */
function amkRotationResourceId(accountId: string, targetDeviceId: string, epoch: number): string {
  return `loombox-amk-rotation-v1:${accountId}:${targetDeviceId}:${epoch}`;
}

/**
 * Derives the AES-256-GCM key that seals/unwraps one rewrapped-AMK-epoch
 * envelope, from the raw ECDH shared secret via the same HMAC-SHA512
 * primitive `key-tree.ts`/`pairing.ts` use (not RFC 5869 HKDF). Domain-
 * separates on the resource id (which already includes accountId/deviceId/
 * epoch), on top of the AAD binding `envelope.ts` applies.
 */
async function deriveRotationAeadKey(
  sharedSecret: Uint8Array,
  resourceId: string,
): Promise<CryptoKey> {
  const { key } = await deriveChild(sharedSecret, new TextEncoder().encode(resourceId));
  return importAesGcmKey(key);
}

export interface WrapAmkEpochForDeviceOptions {
  /** The freshly-minted AMK epoch ({@link generateAmkEpoch}'s output) to wrap. */
  newAmk: Uint8Array;
  /** The epoch number this AMK represents, bound into the AAD. */
  epoch: number;
  accountId: string;
  /** The surviving device this envelope is sealed for. */
  targetDeviceId: string;
  /** The acting (already-unlocked, online, revoking) device's own ECDH private key. */
  actingPrivateKey: CryptoKey;
  /** The target device's already-known raw ECDH public key point (from the device registry). */
  targetDevicePublicKeyRaw: Uint8Array;
}

/**
 * The acting device, revoking another device: ECDH-wraps the new AMK epoch
 * for one surviving device's already-known public key. Call once per
 * surviving device (SPEC §8's wrap-fan-out) — the acting device itself needs
 * no wrap, it already holds `newAmk` directly, having just minted it.
 */
export async function wrapAmkEpochForDevice(
  options: WrapAmkEpochForDeviceOptions,
): Promise<Envelope> {
  const targetPublicKey = await importPublicKeyRaw(options.targetDevicePublicKeyRaw);
  const sharedSecret = await deriveSharedSecretBits(options.actingPrivateKey, targetPublicKey);
  const resourceId = amkRotationResourceId(
    options.accountId,
    options.targetDeviceId,
    options.epoch,
  );
  const key = await deriveRotationAeadKey(sharedSecret, resourceId);
  return encryptEnvelope(resourceId, options.newAmk, key);
}

export interface UnwrapAmkEpochForDeviceOptions {
  envelope: Envelope;
  /** The epoch number the caller expects this envelope to be for (from the relay's plaintext routing metadata alongside the envelope). */
  epoch: number;
  accountId: string;
  /** This (surviving) device's own id — must match what the envelope was sealed for. */
  targetDeviceId: string;
  /** This device's own ECDH private key. */
  targetPrivateKey: CryptoKey;
  /** The acting (revoking) device's already-known raw ECDH public key point. */
  actingDevicePublicKeyRaw: Uint8Array;
}

/**
 * A surviving device, on reconnect: unwraps its rewrapped-AMK-epoch envelope
 * and returns the new AMK. Rejects loudly (the AES-GCM tag check fails) if
 * `epoch`/`accountId`/`targetDeviceId` don't match what the envelope was
 * actually sealed for, if `actingDevicePublicKeyRaw` isn't the real acting
 * device's key (a different ECDH shared secret results), or if the envelope
 * was tampered with in transit.
 */
export async function unwrapAmkEpochForDevice(
  options: UnwrapAmkEpochForDeviceOptions,
): Promise<Uint8Array> {
  const actingPublicKey = await importPublicKeyRaw(options.actingDevicePublicKeyRaw);
  const sharedSecret = await deriveSharedSecretBits(options.targetPrivateKey, actingPublicKey);
  const resourceId = amkRotationResourceId(
    options.accountId,
    options.targetDeviceId,
    options.epoch,
  );
  const key = await deriveRotationAeadKey(sharedSecret, resourceId);
  return decryptEnvelope(resourceId, options.envelope, key);
}
