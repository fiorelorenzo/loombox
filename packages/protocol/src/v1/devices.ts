import { z } from 'zod';
import { base64String, encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Auth + device-lifecycle messages (SPEC §8's device model, §16). The relay
 * only ever stores opaque blobs, device public keys, and the
 * `owner_account_id` binding — never the AMK, a recovery code, or plaintext
 * session-key material.
 */

/** A device registers its identity keypair into the account's device registry. */
export const deviceRegister = z.object({
  type: z.literal('device_register'),
  protocolVersion: z.literal(PROTOCOL_V1),
  deviceId: z.string().min(1),
  devicePublicKey: base64String,
  label: z.string().optional(),
});
export type DeviceRegister = z.infer<typeof deviceRegister>;

/** One device's copy of a freshly-minted AMK epoch, ECDH-wrapped for that device's own public key. */
export const wrappedAmkEnvelope = z.object({
  deviceId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type WrappedAmkEnvelope = z.infer<typeof wrappedAmkEnvelope>;

/**
 * Revokes a device and rotates the AMK (SPEC §8: "the acting device mints a
 * new AMK epoch... and ECDH-wraps that new epoch for each other currently
 * registered device's already-known public key"). `newEpoch` is the account's
 * new AMK epoch number this revoke establishes (relay-validated as exactly
 * one past the account's current epoch, #116); `rewrappedAmk` carries one
 * wrapped copy per surviving device, all wrapped for that same epoch — the
 * revoked `deviceId` gets none.
 */
export const deviceRevoke = z.object({
  type: z.literal('device_revoke'),
  protocolVersion: z.literal(PROTOCOL_V1),
  deviceId: z.string().min(1),
  newEpoch: z.number().int().positive(),
  rewrappedAmk: z.array(wrappedAmkEnvelope),
});
export type DeviceRevoke = z.infer<typeof deviceRevoke>;

/**
 * A surviving device, on reconnect, asks whether the relay is holding a
 * rewrapped-AMK-epoch envelope for it (SPEC §8's wrap-fan-out delivery leg;
 * issue #116). Scoped to the requester's own connection — the relay only
 * ever answers for `connection.deviceId`, never an arbitrary `deviceId` a
 * client might supply (see `relay.ts`'s handler).
 */
export const amkEpochFetchRequest = z.object({
  type: z.literal('amk_epoch_fetch_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  deviceId: z.string().min(1),
});
export type AmkEpochFetchRequest = z.infer<typeof amkEpochFetchRequest>;

/**
 * The relay's reply: this device's own pending rewrapped-AMK-epoch envelope,
 * or `pending: undefined` if there is nothing to adopt (already on the
 * latest epoch, or this account has never rotated). `fromDeviceId`/
 * `fromDevicePublicKey` identify the acting device that wrapped it, exactly
 * as `@loombox/crypto`'s `unwrapAmkEpochForDevice` needs to re-derive the
 * ECDH shared secret — looked up by the relay from its own device registry
 * at fetch time, never trusted from the original `device_revoke` sender.
 * Still just opaque ciphertext plus routing metadata: the relay never learns
 * the AMK.
 */
export const amkEpochFetchResponse = z.object({
  type: z.literal('amk_epoch_fetch_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  deviceId: z.string().min(1),
  pending: z
    .object({
      epoch: z.number().int().positive(),
      fromDeviceId: z.string().min(1),
      fromDevicePublicKey: base64String,
      envelope: encryptedEnvelope,
    })
    .optional(),
});
export type AmkEpochFetchResponse = z.infer<typeof amkEpochFetchResponse>;
export type AmkEpochPendingEnvelope = NonNullable<AmkEpochFetchResponse['pending']>;

/** A device replaces its own identity keypair in place (key rotation without revocation). */
export const deviceRotate = z.object({
  type: z.literal('device_rotate'),
  protocolVersion: z.literal(PROTOCOL_V1),
  deviceId: z.string().min(1),
  newDevicePublicKey: base64String,
});
export type DeviceRotate = z.infer<typeof deviceRotate>;

/**
 * Uploads the recovery-code-wrapped AMK to the relay under the OAuth-
 * authenticated account (SPEC §8 path 2, "recovery-code escrow"). The relay
 * stores `wrappedAmk` as an opaque base64 blob; it never learns the AMK or
 * the Recovery Code that wraps it.
 */
export const amkEscrow = z.object({
  type: z.literal('amk_escrow'),
  protocolVersion: z.literal(PROTOCOL_V1),
  wrappedAmk: base64String,
});
export type AmkEscrow = z.infer<typeof amkEscrow>;

/** A new device, having proven identity via OAuth alone, asks for its account's escrowed AMK blob. */
export const newDeviceBootstrapRequest = z.object({
  type: z.literal('new_device_bootstrap_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  deviceId: z.string().min(1),
  devicePublicKey: base64String,
});
export type NewDeviceBootstrapRequest = z.infer<typeof newDeviceBootstrapRequest>;

/** The relay's reply: the account's escrowed wrapped-AMK blob, still opaque, for local unwrap with the user's Recovery Code. */
export const newDeviceBootstrapResponse = z.object({
  type: z.literal('new_device_bootstrap_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  wrappedAmk: base64String,
});
export type NewDeviceBootstrapResponse = z.infer<typeof newDeviceBootstrapResponse>;

/** A new device presents a pairing code scanned/typed from an already-trusted device (SPEC §8 path 1). */
export const qrPairingRequest = z.object({
  type: z.literal('qr_pairing_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  pairingCode: z.string().min(1),
  newDeviceId: z.string().min(1),
  newDevicePublicKey: base64String,
});
export type QrPairingRequest = z.infer<typeof qrPairingRequest>;

/** The already-trusted device's reply: the AMK, ECDH-wrapped directly for the new device's public key (device-to-device, no relay unwrap). */
export const qrPairingResponse = z.object({
  type: z.literal('qr_pairing_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  pairingCode: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type QrPairingResponse = z.infer<typeof qrPairingResponse>;
