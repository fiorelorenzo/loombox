import { readFile } from 'node:fs/promises';

import { runPgRestore } from './backup';
import { decryptBackup, loadBackupKey } from './backup-crypto';

/**
 * Runnable restore entry point (#103): `pnpm --filter @loombox/relay
 * restore <path-to-encrypted-dump>`, driven by `DATABASE_URL` +
 * `RELAY_BACKUP_ENCRYPTION_KEY`. See `docs/relay-backup.md` for the full
 * restore-drill runbook (create a scratch database, point `DATABASE_URL` at
 * it, restore, verify, then repeat against the real target only once the
 * drill is trusted).
 *
 * Deliberately requires the *decrypted* dump to pass Postgres's own
 * `pg_restore --clean --if-exists` semantics before this process considers
 * itself done — a restore that "succeeds" but silently drops rows is worse
 * than a loud failure, so any error here (bad key, corrupt file,
 * `pg_restore` non-zero exit) propagates and exits non-zero rather than
 * being swallowed.
 */
async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('restore: usage: pnpm --filter @loombox/relay restore <path-to-encrypted-dump>');
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('restore: DATABASE_URL is required (must point at the target database)');
    process.exitCode = 1;
    return;
  }

  const keyB64 = process.env.RELAY_BACKUP_ENCRYPTION_KEY;
  if (!keyB64) {
    console.error('restore: RELAY_BACKUP_ENCRYPTION_KEY is required');
    process.exitCode = 1;
    return;
  }
  const key = loadBackupKey(keyB64);
  const restoreCommand = process.env.RELAY_PG_RESTORE_CMD?.split(/\s+/).filter(Boolean);

  const encrypted = await readFile(filePath);
  const dump = decryptBackup(encrypted, key);
  await runPgRestore({ databaseUrl, dump, command: restoreCommand });
  console.log(`restore: restored ${filePath} into the configured DATABASE_URL`);
}

main().catch((error: unknown) => {
  console.error('restore: failed', error);
  process.exitCode = 1;
});
