import { describe, expect, it } from 'vitest';
import {
  deriveRecoveryWrapKeyBits,
  formatRecoveryCodeForDisplay,
  generateRecoveryCode,
  normalizeRecoveryCode,
  packWrappedAmkForWire,
  unpackWrappedAmkFromWire,
  unwrapAmkWithRecoveryCode,
  wrapAmkWithRecoveryCode,
  type WrappedAmkBlob,
} from './recovery-escrow';

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('recovery code generation + formatting', () => {
  it('generates a dash-grouped, Crockford-base32 code (1Password-secret-key-style)', () => {
    const code = generateRecoveryCode();
    // 8 groups of 4 Crockford base32 chars (digits + uppercase, no I/L/O/U).
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
  });

  it('generates a different code every call', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(20);
  });

  it('formatRecoveryCodeForDisplay groups a raw code with dashes', () => {
    expect(formatRecoveryCodeForDisplay('0123456789ABCDEF')).toBe('0123-4567-89AB-CDEF');
  });

  it('normalizeRecoveryCode strips dashes/whitespace and uppercases', () => {
    expect(normalizeRecoveryCode('0123-4567-89ab-cdef')).toBe('0123456789ABCDEF');
    expect(normalizeRecoveryCode('  0123 4567-89AB-CDEF  ')).toBe('0123456789ABCDEF');
  });

  it('normalizeRecoveryCode is idempotent, so a code round-trips through display formatting', () => {
    const code = generateRecoveryCode();
    const raw = normalizeRecoveryCode(code);
    expect(normalizeRecoveryCode(formatRecoveryCodeForDisplay(raw))).toBe(raw);
  });
});

describe('deriveRecoveryWrapKeyBits (PBKDF2-HMAC-SHA256, a vetted KDF)', () => {
  it('matches a known-answer PBKDF2-HMAC-SHA256 vector (210,000 iterations, 256-bit output)', async () => {
    // Password "TESTCASE0001" (normalizeRecoveryCode("TEST-CASE-0001"), just
    // the dash stripped — chosen with no I/L/O/U so the normalization is
    // exactly "remove the dash"), a fixed 16-byte salt, 210,000 iterations.
    // Expected output computed independently via Node's `crypto.pbkdf2Sync`
    // (a completely separate implementation from this module's WebCrypto
    // `deriveBits` path) — deliberately not imported here, since
    // `@loombox/crypto` must never reference Node's `crypto` builtin
    // anywhere under its `src/`, test files included (see
    // `browser-safety.test.ts`, issue #324). Mirrors `aead.test.ts`'s own
    // "computed independently, not via this package's own WebCrypto path"
    // KAT style.
    const code = 'TEST-CASE-0001';
    const salt = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const expectedHex = 'a1c4a099e39e8ffdfbc1babccb12aaa29e0af36b80e8354f80d435a7611cbe30';

    const derived = await deriveRecoveryWrapKeyBits(code, salt);
    expect(bytesToHex(derived)).toBe(expectedHex);
  });

  it('same (code, salt) always derives the same bits (determinism)', async () => {
    const code = generateRecoveryCode();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const first = await deriveRecoveryWrapKeyBits(code, salt);
    const second = await deriveRecoveryWrapKeyBits(code, salt);
    expect(bytesToHex(first)).toBe(bytesToHex(second));
  });

  it('a different salt derives different bits for the same code', async () => {
    const code = generateRecoveryCode();
    const bitsA = await deriveRecoveryWrapKeyBits(code, new Uint8Array(16).fill(1));
    const bitsB = await deriveRecoveryWrapKeyBits(code, new Uint8Array(16).fill(2));
    expect(bytesToHex(bitsA)).not.toBe(bytesToHex(bitsB));
  });

  it('a different code derives different bits for the same salt', async () => {
    const salt = new Uint8Array(16).fill(7);
    const bitsA = await deriveRecoveryWrapKeyBits(generateRecoveryCode(), salt);
    const bitsB = await deriveRecoveryWrapKeyBits(generateRecoveryCode(), salt);
    expect(bytesToHex(bitsA)).not.toBe(bytesToHex(bitsB));
  });

  it('normalizes input the same way as normalizeRecoveryCode, so dashes/case do not change the derived key', async () => {
    const salt = new Uint8Array(16).fill(9);
    const raw = 'ABCD1234EFGH5678';
    const withDashes = formatRecoveryCodeForDisplay(raw);
    const lower = withDashes.toLowerCase();

    const bitsRaw = await deriveRecoveryWrapKeyBits(raw, salt);
    const bitsDashed = await deriveRecoveryWrapKeyBits(withDashes, salt);
    const bitsLower = await deriveRecoveryWrapKeyBits(lower, salt);

    expect(bytesToHex(bitsDashed)).toBe(bytesToHex(bitsRaw));
    expect(bytesToHex(bitsLower)).toBe(bytesToHex(bitsRaw));
  });
});

describe('wrapAmkWithRecoveryCode / unwrapAmkWithRecoveryCode (AES-256-GCM, AEAD-bound)', () => {
  it('round-trips: wrap then unwrap recovers the exact original AMK', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const code = generateRecoveryCode();
    const accountId = 'acct_123';

    const blob = await wrapAmkWithRecoveryCode(amk, code, accountId);
    const recovered = await unwrapAmkWithRecoveryCode(blob, code, accountId);

    expect(recovered).toEqual(amk);
  });

  it('produces a fresh random salt/iv on every wrap, even for the same inputs', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const code = generateRecoveryCode();
    const accountId = 'acct_123';

    const blobA = await wrapAmkWithRecoveryCode(amk, code, accountId);
    const blobB = await wrapAmkWithRecoveryCode(amk, code, accountId);

    expect(bytesToHex(blobA.salt)).not.toBe(bytesToHex(blobB.salt));
    expect(bytesToHex(blobA.ciphertext)).not.toBe(bytesToHex(blobB.ciphertext));
    // Both still independently unwrap to the same AMK.
    expect(await unwrapAmkWithRecoveryCode(blobA, code, accountId)).toEqual(amk);
    expect(await unwrapAmkWithRecoveryCode(blobB, code, accountId)).toEqual(amk);
  });

  it('rejects unwrap with the wrong Recovery Code (AEAD tag failure, not garbage output)', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const accountId = 'acct_123';
    const blob = await wrapAmkWithRecoveryCode(amk, generateRecoveryCode(), accountId);

    await expect(
      unwrapAmkWithRecoveryCode(blob, generateRecoveryCode(), accountId),
    ).rejects.toThrow();
  });

  it('rejects unwrap for a different accountId (AAD binding), even with the right code', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const code = generateRecoveryCode();
    const blob = await wrapAmkWithRecoveryCode(amk, code, 'acct_a');

    await expect(unwrapAmkWithRecoveryCode(blob, code, 'acct_b')).rejects.toThrow();
  });

  it('rejects unwrap of a tampered ciphertext', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const code = generateRecoveryCode();
    const accountId = 'acct_123';
    const blob = await wrapAmkWithRecoveryCode(amk, code, accountId);
    const tampered: WrappedAmkBlob = {
      ...blob,
      ciphertext: Uint8Array.from(blob.ciphertext),
    };
    tampered.ciphertext[0] ^= 0xff;

    await expect(unwrapAmkWithRecoveryCode(tampered, code, accountId)).rejects.toThrow();
  });
});

describe('packWrappedAmkForWire / unpackWrappedAmkFromWire (the opaque base64 blob the relay stores)', () => {
  it('round-trips a wrapped blob through pack/unpack unchanged', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const code = generateRecoveryCode();
    const accountId = 'acct_123';
    const blob = await wrapAmkWithRecoveryCode(amk, code, accountId);

    const wire = packWrappedAmkForWire(blob);
    expect(typeof wire).toBe('string');
    const unpacked = unpackWrappedAmkFromWire(wire);

    expect(unpacked).toEqual(blob);
    expect(await unwrapAmkWithRecoveryCode(unpacked, code, accountId)).toEqual(amk);
  });

  it('rejects an unsupported format version', () => {
    const bogus = Buffer.from([0xff, 0x00]).toString('base64');
    expect(() => unpackWrappedAmkFromWire(bogus)).toThrow();
  });

  it('rejects a truncated/malformed blob', () => {
    const bogus = Buffer.from([0x01]).toString('base64');
    expect(() => unpackWrappedAmkFromWire(bogus)).toThrow();
  });
});
