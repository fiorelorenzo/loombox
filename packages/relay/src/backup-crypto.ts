import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * At-rest encryption for relay backups (#103, SPEC §9's "backup/DR line").
 * The blob store already carries E2E-encrypted `EncryptedEnvelope`
 * ciphertext (SPEC §8), but a `pg_dump` of the whole database also captures
 * routing metadata (device registry, session index, Better Auth's
 * `user`/`session`/`account`/`verification` tables) that is plaintext at
 * the database layer. This module encrypts the dump artifact itself before
 * it ever touches disk or off-box storage.
 *
 * Chosen approach: `node:crypto` AES-256-GCM with an operator-supplied
 * 256-bit key (`RELAY_BACKUP_ENCRYPTION_KEY`, base64 — generate with
 * `openssl rand -base64 32`, the same convention this repo already uses for
 * `POSTGRES_PASSWORD`/`BETTER_AUTH_SECRET`), not `age`/`gpg`: those are
 * fine tools, but shelling out to a second external binary (on top of
 * `pg_dump`/`pg_restore`, already required) for what is a single
 * authenticated-encryption primitive would be extra process-spawn surface
 * and an extra runtime dependency for no capability `node:crypto` doesn't
 * already provide correctly (AES-256-GCM is an AEAD: it authenticates the
 * ciphertext, so a corrupted or tampered backup fails to decrypt loudly
 * rather than silently restoring garbage).
 */

/** 4-byte magic + 1-byte format version, so a corrupted/foreign file fails fast with a clear error instead of a confusing GCM auth failure. */
const MAGIC = Buffer.from('LBK1', 'ascii');
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ALGORITHM = 'aes-256-gcm';

/**
 * Decodes and validates `RELAY_BACKUP_ENCRYPTION_KEY`. Throws with a clear
 * message on the wrong length rather than letting `createCipheriv` throw an
 * opaque "Invalid key length" — the wrong length is the #1 way to
 * misconfigure this key (e.g. pasting a passphrase instead of running
 * `openssl rand -base64 32`).
 */
export function loadBackupKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `RELAY_BACKUP_ENCRYPTION_KEY must decode (base64) to a ${KEY_LENGTH}-byte key, got ${key.length} bytes. Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/**
 * Encrypts `plaintext` (a raw `pg_dump --format=custom` artifact) into the
 * on-disk envelope: `MAGIC | iv | authTag | ciphertext`. A fresh random IV
 * per call, per AES-GCM's hard requirement of never reusing an IV under the
 * same key.
 */
export function encryptBackup(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, authTag, ciphertext]);
}

/**
 * Decrypts an envelope produced by {@link encryptBackup}. Throws on a bad
 * magic (wrong file / not a loombox backup), a wrong key, or any tampering
 * (GCM auth-tag verification failure) — never returns partial/garbage
 * plaintext.
 */
export function decryptBackup(encrypted: Buffer, key: Buffer): Buffer {
  if (encrypted.length < MAGIC.length + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('relay backup: file too short to be a valid encrypted backup');
  }
  const magic = encrypted.subarray(0, MAGIC.length);
  if (!magic.equals(MAGIC)) {
    throw new Error('relay backup: not a recognized loombox relay backup file (bad magic)');
  }
  let offset = MAGIC.length;
  const iv = encrypted.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = encrypted.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const ciphertext = encrypted.subarray(offset);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
