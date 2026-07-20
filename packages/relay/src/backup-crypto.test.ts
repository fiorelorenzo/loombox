import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { decryptBackup, encryptBackup, loadBackupKey } from './backup-crypto';

function testKey(): Buffer {
  return randomBytes(32);
}

describe('backup-crypto (#103)', () => {
  it('round-trips: decrypt(encrypt(plaintext)) === plaintext', () => {
    const key = testKey();
    const plaintext = Buffer.from(
      'a fake pg_dump --format=custom payload, definitely not real SQL',
    );

    const encrypted = encryptBackup(plaintext, key);
    const decrypted = decryptBackup(encrypted, key);

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('round-trips empty and binary (non-UTF8) plaintext', () => {
    const key = testKey();
    for (const plaintext of [Buffer.alloc(0), Buffer.from([0, 255, 1, 254, 0, 128, 16])]) {
      const decrypted = decryptBackup(encryptBackup(plaintext, key), key);
      expect(decrypted.equals(plaintext)).toBe(true);
    }
  });

  it('produces a different ciphertext (different IV) for the same plaintext on each call', () => {
    const key = testKey();
    const plaintext = Buffer.from('same input, twice');

    const first = encryptBackup(plaintext, key);
    const second = encryptBackup(plaintext, key);

    expect(first.equals(second)).toBe(false);
    // ... but both still decrypt back to the same plaintext.
    expect(decryptBackup(first, key).equals(plaintext)).toBe(true);
    expect(decryptBackup(second, key).equals(plaintext)).toBe(true);
  });

  it('fails to decrypt with the wrong key', () => {
    const encrypted = encryptBackup(Buffer.from('secret dump bytes'), testKey());
    expect(() => decryptBackup(encrypted, testKey())).toThrow();
  });

  it('fails to decrypt a tampered ciphertext (GCM auth tag catches it)', () => {
    const key = testKey();
    const encrypted = encryptBackup(Buffer.from('secret dump bytes'), key);
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff; // flip the last ciphertext byte
    expect(() => decryptBackup(tampered, key)).toThrow();
  });

  it('rejects a file with the wrong magic (not a loombox backup)', () => {
    const key = testKey();
    const notABackup = Buffer.concat([Buffer.from('NOPE'), randomBytes(40)]);
    expect(() => decryptBackup(notABackup, key)).toThrow(/not a recognized/);
  });

  it('rejects a truncated file', () => {
    expect(() => decryptBackup(Buffer.from('short'), testKey())).toThrow(/too short/);
  });

  describe('loadBackupKey', () => {
    it('decodes a valid base64 32-byte key', () => {
      const raw = randomBytes(32);
      const key = loadBackupKey(raw.toString('base64'));
      expect(key.equals(raw)).toBe(true);
    });

    it('throws a clear error for a key of the wrong length', () => {
      expect(() => loadBackupKey(Buffer.from('too short').toString('base64'))).toThrow(
        /32-byte key/,
      );
    });
  });
});
