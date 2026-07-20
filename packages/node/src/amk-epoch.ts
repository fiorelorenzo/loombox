/**
 * Wires a `NodeDaemon`'s AMK-epoch-rotation events (SPEC §8; issue #116) to
 * the actual ECDH unwrap. `NodeDaemon` deliberately never holds this
 * device's own ECDH private key (see its class doc comment: only
 * `devicePublicKey`, a string, is ever passed into it) — this module is
 * where a caller that *does* hold the private key (`main.ts`, via
 * `identity.ts`'s `NodeIdentityStore`) closes that loop.
 */
import { envelopeFromWire, unwrapAmkEpochForDevice, type EcdhKeyPair } from '@loombox/crypto';
import type { AmkEpochPendingEnvelope } from '@loombox/protocol';

import type { NodeDaemon } from './node-daemon';

/** The subset of `identity.ts`'s `NodeIdentity` this module needs — just the ECDH keypair, so a test can construct a minimal fake without going through the real on-disk `NodeIdentityStore`. */
export interface AmkEpochIdentity {
  readonly keyPair: EcdhKeyPair;
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/**
 * Subscribes to `node`'s `'amk-epoch-pending'` event: unwraps the pending
 * envelope with `identity`'s private key against the acting device's public
 * key the relay supplied, and hands the recovered AMK to
 * `node.adoptAmkEpoch`. A failed unwrap (wrong keys, tampered envelope, a
 * stale reply that no longer matches what the relay actually holds) is
 * logged rather than thrown — a bad pending envelope must never crash a
 * running node; it simply stays on its current epoch until a fresh,
 * valid one arrives. Returns an unsubscribe function.
 */
export function wireAmkEpochAdoption(
  node: NodeDaemon,
  identity: AmkEpochIdentity,
  accountId: string,
  deviceId: string,
): () => void {
  const listener = (pending: AmkEpochPendingEnvelope): void => {
    void (async () => {
      try {
        const envelope = envelopeFromWire(pending.envelope);
        const newAmk = await unwrapAmkEpochForDevice({
          envelope,
          epoch: pending.epoch,
          accountId,
          targetDeviceId: deviceId,
          targetPrivateKey: identity.keyPair.privateKey,
          actingDevicePublicKeyRaw: fromBase64(pending.fromDevicePublicKey),
        });
        node.adoptAmkEpoch(newAmk, pending.epoch);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `wireAmkEpochAdoption: failed to unwrap/adopt AMK epoch ${pending.epoch}: ${message}`,
        );
      }
    })();
  };
  node.on('amk-epoch-pending', listener);
  return () => {
    node.off('amk-epoch-pending', listener);
  };
}
