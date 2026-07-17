import { describe, expect, it } from 'vitest';
import { exportPublicKeyRaw, generateEcdhKeyPair } from './ecdh';
import {
  PAIRING_DEFAULT_TTL_MS,
  acceptPairingOffer,
  completePairing,
  createPairingOffer,
  decodePairingOfferFromQr,
  encodePairingOfferForQr,
  generatePairingCode,
  unwrapPairedAmk,
} from './pairing';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('QR/short-code device pairing (issue #113)', () => {
  it('completes the full pair -> register -> AMK-held sequence and matches the SAS verification code on both sides', async () => {
    const amk = utf8('a'.repeat(32)); // stand-in 32-byte AMK

    // Existing (already-trusted) device generates a pairing offer.
    const offerState = await createPairingOffer();
    expect(offerState.offer.pairingCode).toHaveLength(8);
    expect(offerState.offer.existingDevicePublicKey).toHaveLength(65);
    expect(offerState.offer.expiresAt).toBeGreaterThan(Date.now());

    // The offer round-trips through a compact QR-encodable string.
    const qrPayload = encodePairingOfferForQr(offerState.offer);
    expect(typeof qrPayload).toBe('string');
    const decodedOffer = decodePairingOfferFromQr(qrPayload);
    expect(decodedOffer).toEqual(offerState.offer);

    // New device scans the QR, derives its own keypair + the shared secret.
    const acceptance = await acceptPairingOffer(decodedOffer);
    expect(acceptance.pairingCode).toBe(offerState.offer.pairingCode);
    expect(acceptance.newDevicePublicKey).toHaveLength(65);

    // New device sends its public key + pairingCode back (out of band, over
    // the relay's qr_pairing_request); existing device seals the AMK for it.
    const completion = await completePairing(
      offerState,
      acceptance.newDevicePublicKey,
      acceptance.pairingCode,
      amk,
    );
    expect(completion.pairingCode).toBe(offerState.offer.pairingCode);
    expect(completion.envelope.resourceId).toBe(offerState.offer.pairingCode);

    // Both sides display the same short SAS comparison code for an honest run.
    expect(completion.verificationCode).toBe(acceptance.verificationCode);
    expect(completion.verificationCode).toMatch(/^\d{6}$/);

    // New device unwraps the sealed AMK from the response envelope.
    const recoveredAmk = await unwrapPairedAmk(
      acceptance,
      completion.pairingCode,
      completion.envelope,
    );
    expect(recoveredAmk).toEqual(amk);
  });

  it('rejects reusing an already-completed pairing offer (single-use)', async () => {
    const amk = utf8('b'.repeat(32));
    const offerState = await createPairingOffer();
    const acceptance = await acceptPairingOffer(offerState.offer);

    await completePairing(offerState, acceptance.newDevicePublicKey, acceptance.pairingCode, amk);

    await expect(
      completePairing(offerState, acceptance.newDevicePublicKey, acceptance.pairingCode, amk),
    ).rejects.toThrow(/already been completed|consumed/i);
  });

  it('rejects an expired pairing offer on both accept and complete', async () => {
    const amk = utf8('c'.repeat(32));
    const now = Date.now();
    const offerState = await createPairingOffer({ ttlMs: 1000, now });

    await expect(acceptPairingOffer(offerState.offer, { now: now + 2000 })).rejects.toThrow(
      /expired/i,
    );

    const freshAcceptance = await acceptPairingOffer(offerState.offer, { now });
    await expect(
      completePairing(
        offerState,
        freshAcceptance.newDevicePublicKey,
        freshAcceptance.pairingCode,
        amk,
        { now: now + 2000 },
      ),
    ).rejects.toThrow(/expired/i);
  });

  it('uses the default TTL when none is given', async () => {
    const before = Date.now();
    const offerState = await createPairingOffer();
    expect(offerState.offer.expiresAt).toBeGreaterThanOrEqual(before + PAIRING_DEFAULT_TTL_MS);
    expect(offerState.offer.expiresAt).toBeLessThan(before + PAIRING_DEFAULT_TTL_MS + 5000);
  });

  it('rejects completion with the wrong short code (typo / wrong device)', async () => {
    const amk = utf8('d'.repeat(32));
    const offerState = await createPairingOffer();
    const acceptance = await acceptPairingOffer(offerState.offer);

    await expect(
      completePairing(offerState, acceptance.newDevicePublicKey, 'WRONGCODE', amk),
    ).rejects.toThrow(/pairing code/i);
  });

  it('rejects unwrap with the wrong short code', async () => {
    const amk = utf8('e'.repeat(32));
    const offerState = await createPairingOffer();
    const acceptance = await acceptPairingOffer(offerState.offer);
    const completion = await completePairing(
      offerState,
      acceptance.newDevicePublicKey,
      acceptance.pairingCode,
      amk,
    );

    await expect(unwrapPairedAmk(acceptance, 'WRONGCODE', completion.envelope)).rejects.toThrow(
      /pairing code/i,
    );
  });

  it('fails loudly (import rejects) when the QR-carried public key is tampered', async () => {
    const offerState = await createPairingOffer();
    const decodedOffer = decodePairingOfferFromQr(encodePairingOfferForQr(offerState.offer));

    const tamperedKey = new Uint8Array(decodedOffer.existingDevicePublicKey);
    tamperedKey[0] = 0x05; // corrupt the uncompressed-point format prefix (must be 0x04)
    const tamperedOffer = { ...decodedOffer, existingDevicePublicKey: tamperedKey };

    await expect(acceptPairingOffer(tamperedOffer)).rejects.toThrow();
  });

  it('fails loudly (decrypt rejects) when the sealed AMK envelope ciphertext is tampered', async () => {
    const amk = utf8('f'.repeat(32));
    const offerState = await createPairingOffer();
    const acceptance = await acceptPairingOffer(offerState.offer);
    const completion = await completePairing(
      offerState,
      acceptance.newDevicePublicKey,
      acceptance.pairingCode,
      amk,
    );

    const tamperedCiphertext = new Uint8Array(completion.envelope.ciphertext);
    tamperedCiphertext[0] ^= 0xff;
    const tamperedEnvelope = { ...completion.envelope, ciphertext: tamperedCiphertext };

    await expect(
      unwrapPairedAmk(acceptance, completion.pairingCode, tamperedEnvelope),
    ).rejects.toThrow();
  });

  it('produces a different SAS verification code when a public key is swapped in transit (MITM detection)', async () => {
    const amk = utf8('g'.repeat(32));
    const offerState = await createPairingOffer();
    const honestAcceptance = await acceptPairingOffer(offerState.offer);

    // An attacker on the channel swaps in its own public key before the
    // pairing request reaches the existing device.
    const attacker = await generateEcdhKeyPair();
    const attackerPublicKey = await exportPublicKeyRaw(attacker.publicKey);

    const mitmCompletion = await completePairing(
      offerState,
      attackerPublicKey,
      honestAcceptance.pairingCode,
      amk,
    );

    // The existing device's displayed code no longer matches what the real
    // new device computed and would display: a human comparing them catches it.
    expect(mitmCompletion.verificationCode).not.toBe(honestAcceptance.verificationCode);
  });

  it('generatePairingCode produces distinct, fixed-length base32 codes', () => {
    const a = generatePairingCode();
    const b = generatePairingCode();
    expect(a).toHaveLength(8);
    expect(b).toHaveLength(8);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/); // Crockford base32 alphabet
  });
});
