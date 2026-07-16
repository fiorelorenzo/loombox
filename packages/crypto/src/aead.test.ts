import { describe, expect, it } from 'vitest';
import { aesGcmDecrypt, aesGcmEncrypt, importAesGcmKey } from './aead';

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('aead (AES-256-GCM via WebCrypto)', () => {
  it('round-trips encrypt/decrypt with a random IV', async () => {
    const key = await importAesGcmKey(hexToBytes('00'.repeat(32)));
    const plaintext = utf8('hello loombox');
    const aad = utf8('resource-1');

    const { iv, ciphertext } = await aesGcmEncrypt(key, plaintext, aad);
    expect(iv).toHaveLength(12); // 96-bit IV
    // GCM ciphertext = plaintext length + 16-byte (128-bit) tag.
    expect(ciphertext).toHaveLength(plaintext.length + 16);

    const decrypted = await aesGcmDecrypt(key, iv, ciphertext, aad);
    expect(new TextDecoder().decode(decrypted)).toBe('hello loombox');
  });

  it('rejects decryption when the AAD does not match', async () => {
    const key = await importAesGcmKey(hexToBytes('11'.repeat(32)));
    const plaintext = utf8('secret payload');

    const { iv, ciphertext } = await aesGcmEncrypt(key, plaintext, utf8('resource-a'));

    await expect(aesGcmDecrypt(key, iv, ciphertext, utf8('resource-b'))).rejects.toThrow();
  });

  it('rejects decryption when the ciphertext has been tampered with', async () => {
    const key = await importAesGcmKey(hexToBytes('22'.repeat(32)));
    const plaintext = utf8('do not tamper');
    const aad = utf8('resource-x');

    const { iv, ciphertext } = await aesGcmEncrypt(key, plaintext, aad);
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;

    await expect(aesGcmDecrypt(key, iv, tampered, aad)).rejects.toThrow();
  });

  it('matches a known-answer AES-256-GCM vector (cross-checked against node:crypto createCipheriv)', async () => {
    // Fixed key/iv/plaintext/AAD. Expected ciphertext computed independently
    // via node:crypto's createCipheriv('aes-256-gcm', ...), not via this
    // package's own WebCrypto path, so a regression in either implementation
    // would be caught.
    const keyHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const ivHex = '000102030405060708090a0b';
    const plaintext = utf8('loombox known-answer test vector');
    const aad = utf8('resource-kat-001');
    const expectedCiphertextHex =
      '2b6db976a78aba3be62ff8fcdfc41903f0a1e246d00f3a0f4c4793e07e1d6fc0' +
      '9422ef1674e848905ca4d3e3749c67bb';

    const key = await importAesGcmKey(hexToBytes(keyHex));
    const { iv, ciphertext } = await aesGcmEncrypt(key, plaintext, aad, hexToBytes(ivHex));

    expect(bytesToHex(iv)).toBe(ivHex);
    expect(bytesToHex(ciphertext)).toBe(expectedCiphertextHex);

    const decrypted = await aesGcmDecrypt(key, iv, ciphertext, aad);
    expect(decrypted).toEqual(plaintext);
  });
});
