import { describe, expect, it } from 'vitest';
import { base64ToBytes, base64UrlToBytes, bytesToBase64, bytesToBase64Url } from './base64';

/**
 * The codec that replaced this package's `Buffer` usage (see `base64.ts`'s
 * doc comment for the shipped-PWA bug that motivated it). These assertions
 * are pinned against Node's own encoder rather than against hand-written
 * expectations, so a divergence from the encoding every node-side peer
 * already produces on the wire would fail here — the exact class of bug an
 * "it round-trips with itself" test cannot see.
 */
const BYTES = new Uint8Array([0, 1, 2, 62, 63, 64, 127, 128, 200, 253, 254, 255]);

describe('base64', () => {
  it('encodes standard base64 byte-identically to Node', () => {
    expect(bytesToBase64(BYTES)).toBe(Buffer.from(BYTES).toString('base64'));
  });

  it('encodes URL-safe base64 byte-identically to Node (unpadded, - and _)', () => {
    expect(bytesToBase64Url(BYTES)).toBe(Buffer.from(BYTES).toString('base64url'));
  });

  it('decodes what Node encoded, in both alphabets', () => {
    expect(base64ToBytes(Buffer.from(BYTES).toString('base64'))).toEqual(BYTES);
    expect(base64UrlToBytes(Buffer.from(BYTES).toString('base64url'))).toEqual(BYTES);
  });

  it('round-trips every byte value and the empty input', () => {
    const all = new Uint8Array(256).map((_, index) => index);
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
    expect(base64UrlToBytes(bytesToBase64Url(all))).toEqual(all);
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });

  it('accepts padded and standard-alphabet input on the URL-safe decoder', () => {
    // A `+`/`/`-bearing payload padded the standard way still decodes: the
    // QR path re-encodes offers it did not itself produce.
    const standard = Buffer.from(BYTES).toString('base64');
    expect(base64UrlToBytes(standard)).toEqual(BYTES);
  });

  it('rejects a malformed payload rather than returning partial bytes', () => {
    expect(() => base64ToBytes('!!!not base64!!!')).toThrow();
  });
});
