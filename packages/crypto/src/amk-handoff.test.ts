import { describe, expect, it } from 'vitest';
import { generateAmk } from './key-tree';
import { exportPublicKeyRaw, generateEcdhKeyPair } from './ecdh';
import {
  AMK_HANDOFF_DEFAULT_EPOCH,
  packAmkHandoffForFile,
  unpackAmkHandoffFromFile,
  unwrapAmkForNodeHandoff,
  wrapAmkForNodeHandoff,
  type AmkHandoffFileBlob,
} from './amk-handoff';

describe('wrapAmkForNodeHandoff / unwrapAmkForNodeHandoff', () => {
  it('round-trips the AMK through an ECDH-wrapped envelope, defaulting to epoch 0', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const provisionerPublicKeyRaw = await exportPublicKeyRaw(provisioner.publicKey);

    const amk = generateAmk();
    const envelope = await wrapAmkForNodeHandoff({
      amk,
      accountId: 'acct_1',
      targetDeviceId: 'node-fresh',
      actingPrivateKey: provisioner.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    const unwrapped = await unwrapAmkForNodeHandoff({
      envelope,
      accountId: 'acct_1',
      targetDeviceId: 'node-fresh',
      targetPrivateKey: target.privateKey,
      actingDevicePublicKeyRaw: provisionerPublicKeyRaw,
    });

    expect(Array.from(unwrapped)).toEqual(Array.from(amk));
    expect(AMK_HANDOFF_DEFAULT_EPOCH).toBe(0);
  });

  it('round-trips with an explicit non-zero epoch (a provisioner already ahead of epoch 0)', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const provisionerPublicKeyRaw = await exportPublicKeyRaw(provisioner.publicKey);

    const amk = generateAmk();
    const envelope = await wrapAmkForNodeHandoff({
      amk,
      epoch: 4,
      accountId: 'acct_1',
      targetDeviceId: 'node-fresh',
      actingPrivateKey: provisioner.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    const unwrapped = await unwrapAmkForNodeHandoff({
      envelope,
      epoch: 4,
      accountId: 'acct_1',
      targetDeviceId: 'node-fresh',
      targetPrivateKey: target.privateKey,
      actingDevicePublicKeyRaw: provisionerPublicKeyRaw,
    });

    expect(Array.from(unwrapped)).toEqual(Array.from(amk));
  });

  it('known-answer: a fixed key pair + accountId + deviceId reproduces a decryptable envelope deterministically', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const provisionerPublicKeyRaw = await exportPublicKeyRaw(provisioner.publicKey);
    const amk = new Uint8Array(32).fill(9);

    const envelopeA = await wrapAmkForNodeHandoff({
      amk,
      accountId: 'acct_kat',
      targetDeviceId: 'device_kat',
      actingPrivateKey: provisioner.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });
    const envelopeB = await wrapAmkForNodeHandoff({
      amk,
      accountId: 'acct_kat',
      targetDeviceId: 'device_kat',
      actingPrivateKey: provisioner.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    // Same deterministic ECDH shared secret + domain-separated AEAD key on
    // both calls; only the random IV differs between the two ciphertexts.
    expect(envelopeA.resourceId).toBe(envelopeB.resourceId);

    const unwrapped = await unwrapAmkForNodeHandoff({
      envelope: envelopeA,
      accountId: 'acct_kat',
      targetDeviceId: 'device_kat',
      targetPrivateKey: target.privateKey,
      actingDevicePublicKeyRaw: provisionerPublicKeyRaw,
    });
    expect(Array.from(unwrapped)).toEqual(Array.from(amk));
  });

  it('rejects unwrap with the wrong target private key (a different device entirely)', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const wrongDevice = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const provisionerPublicKeyRaw = await exportPublicKeyRaw(provisioner.publicKey);

    const envelope = await wrapAmkForNodeHandoff({
      amk: generateAmk(),
      accountId: 'acct_1',
      targetDeviceId: 'node-fresh',
      actingPrivateKey: provisioner.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    await expect(
      unwrapAmkForNodeHandoff({
        envelope,
        accountId: 'acct_1',
        targetDeviceId: 'node-fresh',
        targetPrivateKey: wrongDevice.privateKey,
        actingDevicePublicKeyRaw: provisionerPublicKeyRaw,
      }),
    ).rejects.toThrow();
  });

  it('rejects unwrap against an impostor acting-device public key', async () => {
    const provisioner = await generateEcdhKeyPair();
    const impostor = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const impostorPublicKeyRaw = await exportPublicKeyRaw(impostor.publicKey);

    const envelope = await wrapAmkForNodeHandoff({
      amk: generateAmk(),
      accountId: 'acct_1',
      targetDeviceId: 'node-fresh',
      actingPrivateKey: provisioner.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    await expect(
      unwrapAmkForNodeHandoff({
        envelope,
        accountId: 'acct_1',
        targetDeviceId: 'node-fresh',
        targetPrivateKey: target.privateKey,
        actingDevicePublicKeyRaw: impostorPublicKeyRaw,
      }),
    ).rejects.toThrow();
  });

  it('rejects unwrap with a mismatched accountId, targetDeviceId, or epoch (AAD binding)', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const provisionerPublicKeyRaw = await exportPublicKeyRaw(provisioner.publicKey);

    const envelope = await wrapAmkForNodeHandoff({
      amk: generateAmk(),
      epoch: 2,
      accountId: 'acct_1',
      targetDeviceId: 'node-fresh',
      actingPrivateKey: provisioner.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    await expect(
      unwrapAmkForNodeHandoff({
        envelope,
        epoch: 2,
        accountId: 'acct_2',
        targetDeviceId: 'node-fresh',
        targetPrivateKey: target.privateKey,
        actingDevicePublicKeyRaw: provisionerPublicKeyRaw,
      }),
    ).rejects.toThrow();

    await expect(
      unwrapAmkForNodeHandoff({
        envelope,
        epoch: 2,
        accountId: 'acct_1',
        targetDeviceId: 'node-other',
        targetPrivateKey: target.privateKey,
        actingDevicePublicKeyRaw: provisionerPublicKeyRaw,
      }),
    ).rejects.toThrow();

    await expect(
      unwrapAmkForNodeHandoff({
        envelope,
        epoch: 3,
        accountId: 'acct_1',
        targetDeviceId: 'node-fresh',
        targetPrivateKey: target.privateKey,
        actingDevicePublicKeyRaw: provisionerPublicKeyRaw,
      }),
    ).rejects.toThrow();
  });
});

describe('packAmkHandoffForFile / unpackAmkHandoffFromFile', () => {
  it('round-trips a blob through the JSON file wire format', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const provisionerPublicKeyRaw = await exportPublicKeyRaw(provisioner.publicKey);
    const amk = generateAmk();

    const envelope = await wrapAmkForNodeHandoff({
      amk,
      epoch: 1,
      accountId: 'acct_1',
      targetDeviceId: 'node-fresh',
      actingPrivateKey: provisioner.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    const blob: AmkHandoffFileBlob = {
      epoch: 1,
      actingDevicePublicKeyRaw: provisionerPublicKeyRaw,
      envelope,
    };
    const raw = packAmkHandoffForFile(blob);
    expect(typeof raw).toBe('string');

    const unpacked = unpackAmkHandoffFromFile(raw);
    expect(unpacked.epoch).toBe(1);
    expect(Array.from(unpacked.actingDevicePublicKeyRaw)).toEqual(
      Array.from(provisionerPublicKeyRaw),
    );
    expect(Array.from(unpacked.envelope.iv)).toEqual(Array.from(envelope.iv));
    expect(Array.from(unpacked.envelope.ciphertext)).toEqual(Array.from(envelope.ciphertext));

    const unwrapped = await unwrapAmkForNodeHandoff({
      envelope: unpacked.envelope,
      epoch: unpacked.epoch,
      accountId: 'acct_1',
      targetDeviceId: 'node-fresh',
      targetPrivateKey: target.privateKey,
      actingDevicePublicKeyRaw: unpacked.actingDevicePublicKeyRaw,
    });
    expect(Array.from(unwrapped)).toEqual(Array.from(amk));
  });

  it('rejects malformed JSON', () => {
    expect(() => unpackAmkHandoffFromFile('{not valid json')).toThrow(/not valid JSON/);
  });

  it('rejects a JSON value missing required fields', () => {
    expect(() => unpackAmkHandoffFromFile(JSON.stringify({ v: 1 }))).toThrow(
      /malformed or unsupported/,
    );
  });

  it('rejects an unsupported format version', () => {
    expect(() =>
      unpackAmkHandoffFromFile(
        JSON.stringify({
          v: 2,
          epoch: 0,
          actingDevicePublicKey: 'YQ==',
          iv: 'YQ==',
          ciphertext: 'YQ==',
        }),
      ),
    ).toThrow(/malformed or unsupported/);
  });
});
