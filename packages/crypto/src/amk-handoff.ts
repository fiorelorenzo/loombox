/**
 * Non-interactive AMK handoff to a freshly-provisioned node over SSH (SPEC
 * §8, §16; issue #399). During `ssh:` auto-provisioning (`packages/node/src/
 * ssh/provision-target.ts`, issue #400), the provisioning app already holds
 * the unlocked Account Master Key and the freshly-provisioned node reports
 * its own freshly-generated device public key (`identity.ts`'s
 * `NodeIdentityStore`) before it can start for real. This module lets the
 * app wrap the AMK for that device pubkey and lets the node unwrap it with
 * its own device private key once the wrapped blob reaches it — no manual
 * Recovery Code paste (`recovery-escrow.ts`'s path) needed for this case.
 *
 * Deliberately a thin wrapper over `amk-rotation.ts`'s
 * {@link wrapAmkEpochForDevice}/{@link unwrapAmkEpochForDevice}: a "wrap the
 * (possibly current) AMK for one specific device's known public key,
 * AAD-bound to (accountId, targetDeviceId, epoch)" primitive is exactly what
 * device revocation's wrap-fan-out already does — the only difference is
 * *when* it's called (provisioning a brand-new device, not re-keying
 * survivors after a revoke) and that the wrapped value is typically the
 * account's *current* epoch, not a freshly-minted one. Reusing the exact
 * same ECDH-then-AES-GCM construction and AAD scheme means this handoff gets
 * the same swap/spoof protection amk-rotation.test.ts already proves, for
 * free.
 */
import type { CryptoKey } from './webcrypto-types';
import type { Envelope } from './envelope';
import { unwrapAmkEpochForDevice, wrapAmkEpochForDevice } from './amk-rotation';

/**
 * The epoch a handoff blob is bound to when the caller doesn't pass one
 * explicitly — 0, matching `packages/node/src/node-daemon.ts`'s
 * `NodeDaemonOptions.amkEpoch` convention ("0 means the account's original
 * AMK, never rotated"). A provisioner that itself already tracks a later
 * epoch (its own `NodeDaemon.getAmkEpoch()`, after one or more revocations)
 * should pass that epoch explicitly instead, so the newly-provisioned node
 * starts already caught up rather than needing a rewrapped-epoch round trip
 * immediately after its first connect.
 */
export const AMK_HANDOFF_DEFAULT_EPOCH = 0;

export interface WrapAmkForNodeHandoffOptions {
  /** The (unlocked) AMK to hand off — typically the account's current AMK, not a freshly-minted epoch. */
  amk: Uint8Array;
  accountId: string;
  /** The freshly-provisioned target node's own stable device id. */
  targetDeviceId: string;
  /** The acting (already-unlocked, provisioning) device's own ECDH private key. */
  actingPrivateKey: CryptoKey;
  /** The target node's freshly-generated, already-known raw ECDH public key point. */
  targetDevicePublicKeyRaw: Uint8Array;
  /** Defaults to {@link AMK_HANDOFF_DEFAULT_EPOCH}. */
  epoch?: number;
}

/**
 * The provisioner (acting device) side: ECDH-wraps `amk` for the target
 * node's already-reported public key. See this module's doc comment for why
 * this is a thin pass-through to {@link wrapAmkEpochForDevice}.
 */
export async function wrapAmkForNodeHandoff(
  options: WrapAmkForNodeHandoffOptions,
): Promise<Envelope> {
  return wrapAmkEpochForDevice({
    newAmk: options.amk,
    epoch: options.epoch ?? AMK_HANDOFF_DEFAULT_EPOCH,
    accountId: options.accountId,
    targetDeviceId: options.targetDeviceId,
    actingPrivateKey: options.actingPrivateKey,
    targetDevicePublicKeyRaw: options.targetDevicePublicKeyRaw,
  });
}

export interface UnwrapAmkForNodeHandoffOptions {
  envelope: Envelope;
  accountId: string;
  /** This (target) node's own device id — must match what the envelope was sealed for. */
  targetDeviceId: string;
  /** This node's own ECDH private key (`identity.ts`'s `NodeIdentityStore`). */
  targetPrivateKey: CryptoKey;
  /** The provisioner's already-known raw ECDH public key point (delivered alongside the envelope — see `packAmkHandoffForFile`). */
  actingDevicePublicKeyRaw: Uint8Array;
  /** Must match what {@link wrapAmkForNodeHandoff} was called with; defaults to {@link AMK_HANDOFF_DEFAULT_EPOCH}. */
  epoch?: number;
}

/**
 * The freshly-provisioned node (target device) side: unwraps the handed-off
 * AMK. Rejects loudly (the AES-GCM tag check fails) if `epoch`/`accountId`/
 * `targetDeviceId` don't match what the envelope was actually sealed for, if
 * `actingDevicePublicKeyRaw` isn't the real provisioner's key, or if the
 * envelope was tampered with in transit — never returns a partially-recovered
 * or garbage AMK.
 */
export async function unwrapAmkForNodeHandoff(
  options: UnwrapAmkForNodeHandoffOptions,
): Promise<Uint8Array> {
  return unwrapAmkEpochForDevice({
    envelope: options.envelope,
    epoch: options.epoch ?? AMK_HANDOFF_DEFAULT_EPOCH,
    accountId: options.accountId,
    targetDeviceId: options.targetDeviceId,
    targetPrivateKey: options.targetPrivateKey,
    actingDevicePublicKeyRaw: options.actingDevicePublicKeyRaw,
  });
}

const HANDOFF_FILE_FORMAT_VERSION = 1;

/** Everything the one-shot file `packages/node/src/amk-handoff-file.ts` reads needs to unwrap a handoff, other than the receiver's own already-known `accountId`/`targetDeviceId`/private key (never taken from the file itself — see that module's doc comment on why). */
export interface AmkHandoffFileBlob {
  epoch: number;
  /** The provisioner's raw ECDH public key point, embedded so the receiving node can derive the same shared secret back without any other out-of-band exchange. */
  actingDevicePublicKeyRaw: Uint8Array;
  envelope: Envelope;
}

interface PackedAmkHandoffFile {
  v: 1;
  epoch: number;
  actingDevicePublicKey: string; // base64 raw EC point
  iv: string; // base64
  ciphertext: string; // base64
}

/**
 * Packs an {@link AmkHandoffFileBlob} into the JSON string
 * `packages/node/src/ssh/amk-handoff-provision.ts` writes to the one-shot
 * remote file. Unlike `recovery-escrow.ts`'s `packWrappedAmkForWire` (a
 * single opaque base64 blob for a wire protocol field), this has no
 * space-efficiency constraint — it's a local file `amk-handoff-file.ts`
 * reads once and deletes — so plain JSON is preferred for its
 * debuggability.
 */
export function packAmkHandoffForFile(blob: AmkHandoffFileBlob): string {
  const packed: PackedAmkHandoffFile = {
    v: HANDOFF_FILE_FORMAT_VERSION,
    epoch: blob.epoch,
    actingDevicePublicKey: Buffer.from(blob.actingDevicePublicKeyRaw).toString('base64'),
    iv: Buffer.from(blob.envelope.iv).toString('base64'),
    ciphertext: Buffer.from(blob.envelope.ciphertext).toString('base64'),
  };
  return JSON.stringify(packed);
}

/**
 * Inverse of {@link packAmkHandoffForFile}. Throws on malformed JSON, a
 * missing/mistyped field, or an unsupported format version — never returns a
 * partially-parsed blob. The returned `envelope.resourceId` is a placeholder
 * (empty string): `unwrapAmkForNodeHandoff`/`decryptEnvelope` never trust an
 * envelope's own `resourceId` field, only the caller's independently-known
 * expected one (`envelope.ts`'s documented convention), so nothing is lost
 * by not carrying it on the wire here.
 */
export function unpackAmkHandoffFromFile(raw: string): AmkHandoffFileBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('@loombox/crypto: malformed wrapped-AMK handoff file (not valid JSON)');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('@loombox/crypto: malformed wrapped-AMK handoff file');
  }

  const packed = parsed as Partial<PackedAmkHandoffFile>;
  if (
    packed.v !== HANDOFF_FILE_FORMAT_VERSION ||
    typeof packed.epoch !== 'number' ||
    typeof packed.actingDevicePublicKey !== 'string' ||
    typeof packed.iv !== 'string' ||
    typeof packed.ciphertext !== 'string'
  ) {
    throw new Error('@loombox/crypto: malformed or unsupported wrapped-AMK handoff file');
  }

  return {
    epoch: packed.epoch,
    actingDevicePublicKeyRaw: new Uint8Array(Buffer.from(packed.actingDevicePublicKey, 'base64')),
    envelope: {
      resourceId: '',
      iv: new Uint8Array(Buffer.from(packed.iv, 'base64')),
      ciphertext: new Uint8Array(Buffer.from(packed.ciphertext, 'base64')),
    },
  };
}
