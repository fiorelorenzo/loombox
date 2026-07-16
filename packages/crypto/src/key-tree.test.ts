import { hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveChild, deriveKeyTree, generateAmk } from './key-tree';

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('generateAmk', () => {
  it('generates 256 bits (32 bytes) of randomness', () => {
    const amk = generateAmk();
    expect(amk).toHaveLength(32);
  });

  it('generates independent values on each call', () => {
    const a = generateAmk();
    const b = generateAmk();
    expect(a).not.toEqual(b);
  });
});

describe('deriveChild (hmac_sha512(chainCode, data) BIP32-style split)', () => {
  it('matches a known-answer vector (cross-checked independently via HMAC-SHA512)', () => {
    // chainCode = bytes 0x00..0x1f, data = utf8 "m/0". Expected key/chainCode
    // computed independently via Python's hmac+hashlib (not this package's
    // node:crypto path), then split into the first/second 32-byte halves of
    // the 64-byte HMAC-SHA512 digest per Happy's construction.
    const chainCode = hexToBytes(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    const data = utf8('m/0');

    const child = deriveChild(chainCode, data);

    expect(bytesToHex(child.key)).toBe(
      'f4e12c3329735f680f2fa9dedcd32137bcb32520cc17961b695286d58ee98201',
    );
    expect(bytesToHex(child.chainCode)).toBe(
      '827a90a3c1127c7c5c00af41f7986a02b7a771a21d2ffbc7383b047f089a75fa',
    );
    expect(child.key).toHaveLength(32);
    expect(child.chainCode).toHaveLength(32);
  });

  it('is deterministic: same (chainCode, data) yields the same child', () => {
    const chainCode = generateAmk();
    const data = utf8('same-input');

    const first = deriveChild(chainCode, data);
    const second = deriveChild(chainCode, data);

    expect(first.key).toEqual(second.key);
    expect(first.chainCode).toEqual(second.chainCode);
  });

  it('is independent: different data yields a different child', () => {
    const chainCode = generateAmk();

    const a = deriveChild(chainCode, utf8('path-a'));
    const b = deriveChild(chainCode, utf8('path-b'));

    expect(a.key).not.toEqual(b.key);
    expect(a.chainCode).not.toEqual(b.chainCode);
  });

  it('is NOT HKDF-compatible: differs from RFC 5869 HKDF-SHA512 over the same inputs', () => {
    const chainCode = hexToBytes(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    const data = utf8('m/0');

    const child = deriveChild(chainCode, data);
    const ourDigest = new Uint8Array([...child.key, ...child.chainCode]);

    // Real HKDF-SHA512 (RFC 5869) over the same (ikm, info) with an empty
    // salt, extended to the same 64-byte output length.
    const hkdfOut = new Uint8Array(hkdfSync('sha512', chainCode, new Uint8Array(0), data, 64));

    expect(ourDigest).not.toEqual(hkdfOut);
  });
});

describe('deriveKeyTree', () => {
  it('walks children from the AMK root and matches deriveChild step-by-step', () => {
    const amk = generateAmk();

    const viaTree = deriveKeyTree(amk, ['session', 'abc123']);

    const step1 = deriveChild(amk, utf8('session'));
    const step2 = deriveChild(step1.chainCode, utf8('abc123'));

    expect(viaTree.key).toEqual(step2.key);
    expect(viaTree.chainCode).toEqual(step2.chainCode);
  });

  it('is deterministic: the same (AMK, path) derives the same key twice', () => {
    const amk = generateAmk();
    const path = ['session', 'my-session-id'];

    const first = deriveKeyTree(amk, path);
    const second = deriveKeyTree(amk, path);

    expect(first.key).toEqual(second.key);
  });

  it('is independent: different paths derive independent keys', () => {
    const amk = generateAmk();

    const session = deriveKeyTree(amk, ['session', 'a']);
    const otherSession = deriveKeyTree(amk, ['session', 'b']);
    const device = deriveKeyTree(amk, ['device', 'a']);

    expect(session.key).not.toEqual(otherSession.key);
    expect(session.key).not.toEqual(device.key);
  });

  it('matches a known-answer vector for a single-segment path', () => {
    const amk = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');

    const node = deriveKeyTree(amk, ['m/0']);

    expect(bytesToHex(node.key)).toBe(
      'f4e12c3329735f680f2fa9dedcd32137bcb32520cc17961b695286d58ee98201',
    );
  });
});
