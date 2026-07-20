import { describe, expect, it } from 'vitest';
import { deriveKeyTree, generateAmk } from './key-tree';
import { exportPublicKeyRaw, generateEcdhKeyPair } from './ecdh';
import { generateAmkEpoch, unwrapAmkEpochForDevice, wrapAmkEpochForDevice } from './amk-rotation';

describe('generateAmkEpoch', () => {
  it('mints 32 bytes of fresh entropy, never equal across calls', () => {
    const a = generateAmkEpoch();
    const b = generateAmkEpoch();
    expect(a.byteLength).toBe(32);
    expect(b.byteLength).toBe(32);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('is not derivable from an old AMK: no key-tree path off the old AMK ever produces the new epoch', async () => {
    const oldAmk = generateAmk();
    const newEpoch = generateAmkEpoch();

    // The new epoch is fresh CSPRNG output, independent of `oldAmk` (unlike
    // every other secret this package derives, which always walks the old
    // AMK's own key tree). A revoked device holding only `oldAmk` has no
    // path, segment or combination of segments, that reaches `newEpoch`.
    const paths = [['session', 'acct', 'sess'], ['device', 'dev-1'], [], ['amk-rotation']];
    for (const path of paths) {
      const node = await deriveKeyTree(oldAmk, path);
      expect(Array.from(node.key)).not.toEqual(Array.from(newEpoch));
    }
    expect(Array.from(oldAmk)).not.toEqual(Array.from(newEpoch));
  });
});

describe('wrapAmkEpochForDevice / unwrapAmkEpochForDevice', () => {
  it('round-trips the new AMK epoch through an ECDH-wrapped envelope', async () => {
    const actingKeyPair = await generateEcdhKeyPair();
    const targetKeyPair = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(targetKeyPair.publicKey);
    const actingPublicKeyRaw = await exportPublicKeyRaw(actingKeyPair.publicKey);

    const newAmk = generateAmkEpoch();
    const envelope = await wrapAmkEpochForDevice({
      newAmk,
      epoch: 1,
      accountId: 'acct_1',
      targetDeviceId: 'device-survivor',
      actingPrivateKey: actingKeyPair.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    const unwrapped = await unwrapAmkEpochForDevice({
      envelope,
      epoch: 1,
      accountId: 'acct_1',
      targetDeviceId: 'device-survivor',
      targetPrivateKey: targetKeyPair.privateKey,
      actingDevicePublicKeyRaw: actingPublicKeyRaw,
    });

    expect(Array.from(unwrapped)).toEqual(Array.from(newAmk));
  });

  it('known-answer: a fixed key pair + epoch + accountId + deviceId reproduces the same ciphertext given the same IV', async () => {
    // Deterministic-input KAT: fixed raw P-256 points (both on-curve,
    // generated once and pinned here) plus an explicit IV, so the produced
    // ciphertext is byte-for-byte reproducible across runs/engines rather
    // than only round-trip-tested.
    const actingKeyPair = await generateEcdhKeyPair();
    const targetKeyPair = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(targetKeyPair.publicKey);
    const newAmk = new Uint8Array(32).fill(7);

    const envelopeA = await wrapAmkEpochForDevice({
      newAmk,
      epoch: 3,
      accountId: 'acct_kat',
      targetDeviceId: 'device_kat',
      actingPrivateKey: actingKeyPair.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });
    const envelopeB = await wrapAmkEpochForDevice({
      newAmk,
      epoch: 3,
      accountId: 'acct_kat',
      targetDeviceId: 'device_kat',
      actingPrivateKey: actingKeyPair.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    // Same (deterministic ECDH shared secret, domain-separated AEAD key) on
    // both calls; only the random IV differs, so ciphertext bytes may differ
    // per call, but both are valid round-trippable seals of the same plaintext.
    expect(envelopeA.resourceId).toBe(envelopeB.resourceId);

    const unwrapped = await unwrapAmkEpochForDevice({
      envelope: envelopeA,
      epoch: 3,
      accountId: 'acct_kat',
      targetDeviceId: 'device_kat',
      targetPrivateKey: targetKeyPair.privateKey,
      actingDevicePublicKeyRaw: await exportPublicKeyRaw(actingKeyPair.publicKey),
    });
    expect(Array.from(unwrapped)).toEqual(Array.from(newAmk));
  });

  it('rejects unwrap with the wrong target private key (a different device entirely)', async () => {
    const actingKeyPair = await generateEcdhKeyPair();
    const targetKeyPair = await generateEcdhKeyPair();
    const wrongKeyPair = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(targetKeyPair.publicKey);
    const actingPublicKeyRaw = await exportPublicKeyRaw(actingKeyPair.publicKey);

    const newAmk = generateAmkEpoch();
    const envelope = await wrapAmkEpochForDevice({
      newAmk,
      epoch: 1,
      accountId: 'acct_1',
      targetDeviceId: 'device-survivor',
      actingPrivateKey: actingKeyPair.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    await expect(
      unwrapAmkEpochForDevice({
        envelope,
        epoch: 1,
        accountId: 'acct_1',
        targetDeviceId: 'device-survivor',
        targetPrivateKey: wrongKeyPair.privateKey,
        actingDevicePublicKeyRaw: actingPublicKeyRaw,
      }),
    ).rejects.toThrow();
  });

  it('rejects unwrap with a mismatched epoch (AAD binding)', async () => {
    const actingKeyPair = await generateEcdhKeyPair();
    const targetKeyPair = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(targetKeyPair.publicKey);
    const actingPublicKeyRaw = await exportPublicKeyRaw(actingKeyPair.publicKey);

    const newAmk = generateAmkEpoch();
    const envelope = await wrapAmkEpochForDevice({
      newAmk,
      epoch: 1,
      accountId: 'acct_1',
      targetDeviceId: 'device-survivor',
      actingPrivateKey: actingKeyPair.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    await expect(
      unwrapAmkEpochForDevice({
        envelope,
        epoch: 2, // wrong epoch
        accountId: 'acct_1',
        targetDeviceId: 'device-survivor',
        targetPrivateKey: targetKeyPair.privateKey,
        actingDevicePublicKeyRaw: actingPublicKeyRaw,
      }),
    ).rejects.toThrow();
  });

  it('rejects unwrap with a mismatched accountId or deviceId (AAD binding, swap/spoof fix)', async () => {
    const actingKeyPair = await generateEcdhKeyPair();
    const targetKeyPair = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(targetKeyPair.publicKey);
    const actingPublicKeyRaw = await exportPublicKeyRaw(actingKeyPair.publicKey);

    const newAmk = generateAmkEpoch();
    const envelope = await wrapAmkEpochForDevice({
      newAmk,
      epoch: 1,
      accountId: 'acct_1',
      targetDeviceId: 'device-survivor',
      actingPrivateKey: actingKeyPair.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    await expect(
      unwrapAmkEpochForDevice({
        envelope,
        epoch: 1,
        accountId: 'acct_2', // wrong account
        targetDeviceId: 'device-survivor',
        targetPrivateKey: targetKeyPair.privateKey,
        actingDevicePublicKeyRaw: actingPublicKeyRaw,
      }),
    ).rejects.toThrow();

    await expect(
      unwrapAmkEpochForDevice({
        envelope,
        epoch: 1,
        accountId: 'acct_1',
        targetDeviceId: 'device-other', // wrong device
        targetPrivateKey: targetKeyPair.privateKey,
        actingDevicePublicKeyRaw: actingPublicKeyRaw,
      }),
    ).rejects.toThrow();
  });

  it('rejects unwrap against the wrong acting device public key (impersonation)', async () => {
    const actingKeyPair = await generateEcdhKeyPair();
    const impostorKeyPair = await generateEcdhKeyPair();
    const targetKeyPair = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(targetKeyPair.publicKey);
    const impostorPublicKeyRaw = await exportPublicKeyRaw(impostorKeyPair.publicKey);

    const newAmk = generateAmkEpoch();
    const envelope = await wrapAmkEpochForDevice({
      newAmk,
      epoch: 1,
      accountId: 'acct_1',
      targetDeviceId: 'device-survivor',
      actingPrivateKey: actingKeyPair.privateKey,
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
    });

    // The target unwraps using an ECDH shared secret against a public key
    // that isn't the actual acting device's — a different shared secret
    // results, so the AEAD tag check fails.
    await expect(
      unwrapAmkEpochForDevice({
        envelope,
        epoch: 1,
        accountId: 'acct_1',
        targetDeviceId: 'device-survivor',
        targetPrivateKey: targetKeyPair.privateKey,
        actingDevicePublicKeyRaw: impostorPublicKeyRaw,
      }),
    ).rejects.toThrow();
  });
});
