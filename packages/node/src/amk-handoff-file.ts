import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import {
  unpackAmkHandoffFromFile,
  unwrapAmkForNodeHandoff,
  type EcdhKeyPair,
} from '@loombox/crypto';

import { ConfigError } from './config';

/**
 * The subset of `identity.ts`'s `NodeIdentity` this module needs — just the
 * ECDH keypair, so a test can construct a minimal fake without going through
 * the real on-disk `NodeIdentityStore` (mirrors `amk-epoch.ts`'s
 * `AmkEpochIdentity`).
 */
export interface WrappedAmkFileIdentity {
  readonly keyPair: EcdhKeyPair;
}

export interface AdoptWrappedAmkFileOptions {
  /** `LOOMBOX_WRAPPED_AMK_FILE` — the one-shot file a provisioner (`./ssh/amk-handoff-provision.ts`) wrote. */
  filePath: string;
  accountId: string;
  /** This node's own device id — must match what the provisioner wrapped for. */
  targetDeviceId: string;
  /** This node's own persisted ECDH identity (`identity.ts`'s `NodeIdentityStore`). */
  identity: WrappedAmkFileIdentity;
  /** Injectable for tests: overrides the `node:fs` functions used to read/delete the file. Defaults to the real ones. */
  fs?: {
    existsSync: typeof existsSync;
    readFileSync: typeof readFileSync;
    unlinkSync: typeof unlinkSync;
  };
}

/**
 * The node RECEIVER side of issue #399's zero-touch AMK handoff. On first
 * start, reads the one-shot wrapped-AMK file a provisioner left on this host
 * (`./ssh/amk-handoff-provision.ts`'s `writeWrappedAmkHandoff`), unwraps it
 * with this node's own ECDH private key (`@loombox/crypto`'s
 * `unwrapAmkForNodeHandoff`), and — only once that succeeds — deletes the
 * file, so a restart never re-reads a stale or already-adopted handoff. This
 * is the THIRD AMK source `config.ts`'s `LOOMBOX_WRAPPED_AMK_FILE` documents,
 * alongside the raw `LOOMBOX_AMK` override and the `LOOMBOX_RECOVERY_CODE`
 * bootstrap (`amk-bootstrap.ts`) — see `main.ts`'s `resolveAmk` for the
 * precedence between all three.
 *
 * Throws {@link ConfigError} — never silently adopts a partial or garbage
 * AMK — when: the file doesn't exist (nothing was handed off yet, or it was
 * already consumed by a prior successful start); it isn't valid JSON or the
 * expected shape (`@loombox/crypto`'s `unpackAmkHandoffFromFile` rejects it,
 * a corrupt blob); or the AES-GCM unwrap itself fails (wrong device key —
 * this file wasn't wrapped for *this* node's public key, or this node's
 * `accountId`/`targetDeviceId` doesn't match what the provisioner used —
 * or the file was tampered with). On any of those failures the file is left
 * in place, deliberately not deleted, so the operator can inspect it or
 * re-run provisioning rather than this losing the only copy of a handoff
 * that never actually landed.
 */
export async function adoptWrappedAmkFromFile(
  options: AdoptWrappedAmkFileOptions,
): Promise<Uint8Array> {
  const fsImpl = options.fs ?? { existsSync, readFileSync, unlinkSync };

  if (!fsImpl.existsSync(options.filePath)) {
    throw new ConfigError(
      `wrapped-AMK handoff file not found at "${options.filePath}" (LOOMBOX_WRAPPED_AMK_FILE) — ` +
        'the provisioner may not have written it yet, or it was already consumed by a previous start',
    );
  }

  let raw: string;
  try {
    raw = fsImpl.readFileSync(options.filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `could not read wrapped-AMK handoff file "${options.filePath}": ${message}`,
    );
  }

  let blob;
  try {
    blob = unpackAmkHandoffFromFile(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`wrapped-AMK handoff file "${options.filePath}" is corrupt: ${message}`);
  }

  let amk: Uint8Array;
  try {
    amk = await unwrapAmkForNodeHandoff({
      envelope: blob.envelope,
      epoch: blob.epoch,
      accountId: options.accountId,
      targetDeviceId: options.targetDeviceId,
      targetPrivateKey: options.identity.keyPair.privateKey,
      actingDevicePublicKeyRaw: blob.actingDevicePublicKeyRaw,
    });
  } catch {
    throw new ConfigError(
      `could not unwrap wrapped-AMK handoff file "${options.filePath}" — it was not wrapped for ` +
        "this node's device key/accountId/deviceId, or it was tampered with",
    );
  }

  // Consumed exactly once: only deleted after a successful unwrap, so a
  // corrupt/wrong-key file stays in place for the operator to inspect
  // rather than silently vanishing on a failed attempt.
  fsImpl.unlinkSync(options.filePath);

  return amk;
}
