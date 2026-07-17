import { describe, expect, it } from 'vitest';
import { deriveChild, deriveKeyTree, generateAmk } from './key-tree';

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * A from-scratch RFC 5869 HKDF-SHA512 over WebCrypto (`crypto.subtle`'s
 * built-in `'HKDF'` deriveBits algorithm), used only by the "not HKDF" test
 * below as the real-HKDF comparison point. Deliberately not this package's
 * own primitive, and deliberately not a Node builtin, so the comparison
 * stays meaningful and this test file stays as browser-safe as the source
 * it's testing.
 */
async function referenceHkdfSha512(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as Uint8Array<ArrayBuffer>, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-512',
      salt: salt as Uint8Array<ArrayBuffer>,
      info: info as Uint8Array<ArrayBuffer>,
    },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

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

describe('deriveChild (hmac_sha512(chainCode, data) BIP32-style split, via WebCrypto)', () => {
  it('matches a known-answer vector (cross-checked independently via HMAC-SHA512)', async () => {
    // chainCode = bytes 0x00..0x1f, data = utf8 "m/0". Expected key/chainCode
    // computed independently (via Python's hmac+hashlib, not this package's
    // own implementation), then split into the first/second 32-byte halves of
    // the 64-byte HMAC-SHA512 digest per Happy's construction.
    const chainCode = hexToBytes(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    const data = utf8('m/0');

    const child = await deriveChild(chainCode, data);

    expect(bytesToHex(child.key)).toBe(
      'f4e12c3329735f680f2fa9dedcd32137bcb32520cc17961b695286d58ee98201',
    );
    expect(bytesToHex(child.chainCode)).toBe(
      '827a90a3c1127c7c5c00af41f7986a02b7a771a21d2ffbc7383b047f089a75fa',
    );
    expect(child.key).toHaveLength(32);
    expect(child.chainCode).toHaveLength(32);
  });

  it('is deterministic: same (chainCode, data) yields the same child', async () => {
    const chainCode = generateAmk();
    const data = utf8('same-input');

    const first = await deriveChild(chainCode, data);
    const second = await deriveChild(chainCode, data);

    expect(first.key).toEqual(second.key);
    expect(first.chainCode).toEqual(second.chainCode);
  });

  it('is independent: different data yields a different child', async () => {
    const chainCode = generateAmk();

    const a = await deriveChild(chainCode, utf8('path-a'));
    const b = await deriveChild(chainCode, utf8('path-b'));

    expect(a.key).not.toEqual(b.key);
    expect(a.chainCode).not.toEqual(b.chainCode);
  });

  it('is NOT HKDF-compatible: differs from RFC 5869 HKDF-SHA512 over the same inputs', async () => {
    const chainCode = hexToBytes(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    const data = utf8('m/0');

    const child = await deriveChild(chainCode, data);
    const ourDigest = new Uint8Array([...child.key, ...child.chainCode]);

    // Real HKDF-SHA512 (RFC 5869) over the same (ikm, info) with an empty
    // salt, extended to the same 64-byte output length.
    const hkdfOut = await referenceHkdfSha512(chainCode, new Uint8Array(0), data, 64);

    expect(ourDigest).not.toEqual(hkdfOut);
  });
});

describe('deriveKeyTree', () => {
  it('walks children from the AMK root and matches deriveChild step-by-step', async () => {
    const amk = generateAmk();

    const viaTree = await deriveKeyTree(amk, ['session', 'abc123']);

    const step1 = await deriveChild(amk, utf8('session'));
    const step2 = await deriveChild(step1.chainCode, utf8('abc123'));

    expect(viaTree.key).toEqual(step2.key);
    expect(viaTree.chainCode).toEqual(step2.chainCode);
  });

  it('is deterministic: the same (AMK, path) derives the same key twice', async () => {
    const amk = generateAmk();
    const path = ['session', 'my-session-id'];

    const first = await deriveKeyTree(amk, path);
    const second = await deriveKeyTree(amk, path);

    expect(first.key).toEqual(second.key);
  });

  it('is independent: different paths derive independent keys', async () => {
    const amk = generateAmk();

    const session = await deriveKeyTree(amk, ['session', 'a']);
    const otherSession = await deriveKeyTree(amk, ['session', 'b']);
    const device = await deriveKeyTree(amk, ['device', 'a']);

    expect(session.key).not.toEqual(otherSession.key);
    expect(session.key).not.toEqual(device.key);
  });

  it('matches a known-answer vector for a single-segment path', async () => {
    const amk = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');

    const node = await deriveKeyTree(amk, ['m/0']);

    expect(bytesToHex(node.key)).toBe(
      'f4e12c3329735f680f2fa9dedcd32137bcb32520cc17961b695286d58ee98201',
    );
  });
});
