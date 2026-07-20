import { describe, expect, it, vi } from 'vitest';

import {
  envelopeToWire,
  exportPublicKeyRaw,
  generateAmkEpoch,
  generateEcdhKeyPair,
  wrapAmkEpochForDevice,
} from '@loombox/crypto';

import { wireAmkEpochAdoption, type AmkEpochIdentity } from './amk-epoch';
import { NodeDaemon } from './node-daemon';

/** A bare, never-connected `NodeDaemon` — `new NodeDaemon(...)` doesn't dial the relay itself (only `createNode`'s extra `.connect()` call does), so this is safe to construct in a pure unit test. */
function bareDaemon(): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-unit',
    deviceId: 'device-unit',
    devicePublicKey: 'YWJjZA==',
    authToken: 'acct-unit',
    accountId: 'acct-unit',
    amk: new Uint8Array(32),
  });
}

describe('wireAmkEpochAdoption (#116)', () => {
  it('unwraps a genuine pending envelope and adopts it', async () => {
    const accountId = 'acct-wire-1';
    const survivorKeyPair = await generateEcdhKeyPair();
    const survivorIdentity: AmkEpochIdentity = { keyPair: survivorKeyPair };
    const survivorPublicKeyRaw = await exportPublicKeyRaw(survivorKeyPair.publicKey);

    const actingKeyPair = await generateEcdhKeyPair();
    const actingPublicKeyBase64 = Buffer.from(
      await exportPublicKeyRaw(actingKeyPair.publicKey),
    ).toString('base64');

    const newAmk = generateAmkEpoch();
    const envelope = await wrapAmkEpochForDevice({
      newAmk,
      epoch: 1,
      accountId,
      targetDeviceId: 'device-survivor',
      actingPrivateKey: actingKeyPair.privateKey,
      targetDevicePublicKeyRaw: survivorPublicKeyRaw,
    });

    const node = bareDaemon();
    const unwire = wireAmkEpochAdoption(node, survivorIdentity, accountId, 'device-survivor');

    const adopted = new Promise<{ epoch: number }>((resolve) =>
      node.once('amk-epoch-adopted', resolve),
    );
    node.emit('amk-epoch-pending', {
      epoch: 1,
      fromDeviceId: 'device-acting',
      fromDevicePublicKey: actingPublicKeyBase64,
      envelope: envelopeToWire(envelope),
    });

    const event = await adopted;
    expect(event.epoch).toBe(1);
    expect(node.currentAmkEpoch).toBe(1);
    unwire();
  });

  it('logs a warning and never adopts anything when the envelope fails to unwrap (wrong keys)', async () => {
    const accountId = 'acct-wire-2';
    const survivorKeyPair = await generateEcdhKeyPair();
    const survivorIdentity: AmkEpochIdentity = { keyPair: survivorKeyPair };

    // Wrapped for a *different* target device entirely — the survivor's own
    // ECDH private key derives a different shared secret, so unwrap fails.
    const actingKeyPair = await generateEcdhKeyPair();
    const someoneElseKeyPair = await generateEcdhKeyPair();
    const someoneElsePublicKeyRaw = await exportPublicKeyRaw(someoneElseKeyPair.publicKey);
    const actingPublicKeyBase64 = Buffer.from(
      await exportPublicKeyRaw(actingKeyPair.publicKey),
    ).toString('base64');

    const envelope = await wrapAmkEpochForDevice({
      newAmk: generateAmkEpoch(),
      epoch: 1,
      accountId,
      targetDeviceId: 'device-someone-else',
      actingPrivateKey: actingKeyPair.privateKey,
      targetDevicePublicKeyRaw: someoneElsePublicKeyRaw,
    });

    const node = bareDaemon();
    const unwire = wireAmkEpochAdoption(node, survivorIdentity, accountId, 'device-survivor');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    node.emit('amk-epoch-pending', {
      epoch: 1,
      fromDeviceId: 'device-acting',
      fromDevicePublicKey: actingPublicKeyBase64,
      envelope: envelopeToWire(envelope),
    });

    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to unwrap/adopt')),
    );
    expect(node.currentAmkEpoch).toBe(0);

    warnSpy.mockRestore();
    unwire();
  });
});
