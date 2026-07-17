import { describe, expect, it } from 'vitest';
import { importAesGcmKey } from './aead';
import { decryptEnvelope, encryptEnvelope } from './envelope';
import { envelopeFromWire, envelopeToWire, openJson, sealJson } from './session-envelope';

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

describe('envelopeToWire / envelopeFromWire', () => {
  it('round-trips a crypto Envelope through the wire base64 shape unchanged', async () => {
    const key = await importAesGcmKey(hexToBytes('11'.repeat(32)));
    const envelope = await encryptEnvelope('res-1', new TextEncoder().encode('hello'), key);

    const wire = envelopeToWire(envelope);
    expect(wire).toEqual({
      resourceId: 'res-1',
      iv: Buffer.from(envelope.iv).toString('base64'),
      ciphertext: Buffer.from(envelope.ciphertext).toString('base64'),
      alg: 'AES-256-GCM',
    });

    const roundTripped = envelopeFromWire(wire);
    expect(roundTripped).toEqual(envelope);
  });
});

describe('sealJson / openJson', () => {
  it('round-trips an arbitrary JSON value through seal + open under the same key/resourceId', async () => {
    const key = await importAesGcmKey(hexToBytes('22'.repeat(32)));
    const value = { title: 'my session', projectPath: '/home/dev/project', nested: [1, 2, 3] };

    const wire = await sealJson('sess-1', value, key);
    expect(wire.resourceId).toBe('sess-1');
    expect(wire.alg).toBe('AES-256-GCM');

    const opened = await openJson<typeof value>('sess-1', wire, key);
    expect(opened).toEqual(value);
  });

  it('produces ciphertext that never contains the plaintext verbatim', async () => {
    const key = await importAesGcmKey(hexToBytes('33'.repeat(32)));
    const wire = await sealJson('sess-2', { title: 'super secret title' }, key);

    const raw = Buffer.from(wire.ciphertext, 'base64').toString('latin1');
    expect(raw.includes('super secret title')).toBe(false);
  });

  it('fails to open under the wrong resourceId (AAD binding), matching decryptEnvelope directly', async () => {
    const key = await importAesGcmKey(hexToBytes('44'.repeat(32)));
    const wire = await sealJson('sess-3', { text: 'do not leak' }, key);

    await expect(openJson('sess-other', wire, key)).rejects.toThrow();
  });

  it('interoperates with the raw crypto envelope primitives (sealJson output opens via decryptEnvelope + envelopeFromWire)', async () => {
    const key = await importAesGcmKey(hexToBytes('55'.repeat(32)));
    const value = { text: 'follow-up prompt' };

    const wire = await sealJson('sess-4', value, key);
    const plaintext = await decryptEnvelope('sess-4', envelopeFromWire(wire), key);
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual(value);
  });
});
