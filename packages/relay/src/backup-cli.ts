import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  backupFilename,
  DEFAULT_BACKUP_RETENTION_COUNT,
  runPgDump,
  selectFilesToPrune,
} from './backup';
import { decryptBackup, encryptBackup, loadBackupKey } from './backup-crypto';

/**
 * Runnable backup entry point (#103): `pnpm --filter @loombox/relay backup`,
 * driven by `DATABASE_URL` + `RELAY_BACKUP_ENCRYPTION_KEY`. Mirrors
 * `prune-cli.ts`'s shape: read env, do the thing, print a one-line summary,
 * non-zero exit on failure so a systemd timer/cron job's own failure
 * detection (`OnFailure=`, or cron's mail-on-nonzero-exit) actually fires —
 * see `docs/relay-backup.md` for the nightly-schedule + off-box-shipping
 * runbook this is meant to run under.
 *
 * Dumps the *entire* configured database, not a hand-picked table list: the
 * relay's own tables (#96) live in the same Postgres database as Better
 * Auth's `user`/`session`/`account`/`verification` tables (`auth.ts`) and
 * any future wrapped-AMK escrow table (SPEC §8/§9) will too — a whole-
 * database `pg_dump` covers all of them by construction, including tables
 * added after this code was written, with nothing here needing to
 * enumerate or track them.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('backup: DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }

  const keyB64 = process.env.RELAY_BACKUP_ENCRYPTION_KEY;
  if (!keyB64) {
    console.error('backup: RELAY_BACKUP_ENCRYPTION_KEY is required (openssl rand -base64 32)');
    process.exitCode = 1;
    return;
  }
  const key = loadBackupKey(keyB64);

  const dir = process.env.RELAY_BACKUP_DIR ?? './backups';
  const retentionCount = process.env.RELAY_BACKUP_RETENTION_COUNT
    ? Number(process.env.RELAY_BACKUP_RETENTION_COUNT)
    : DEFAULT_BACKUP_RETENTION_COUNT;
  const dumpCommand = process.env.RELAY_PG_DUMP_CMD?.split(/\s+/).filter(Boolean);

  await mkdir(dir, { recursive: true });

  const dump = await runPgDump({ databaseUrl, command: dumpCommand });
  const encrypted = encryptBackup(dump, key);
  // Fails loudly on a corrupt encryption (rather than shipping an unrestorable
  // artifact off-box and only discovering that during an actual disaster).
  decryptBackup(encrypted, key);

  const filename = backupFilename(new Date());
  const filePath = join(dir, filename);
  await writeFile(filePath, encrypted);
  console.log(
    `backup: wrote ${filename} (${String(dump.length)} raw / ${String(encrypted.length)} encrypted bytes)`,
  );

  const existing = await readdir(dir);
  const toPrune = selectFilesToPrune(existing, retentionCount);
  for (const name of toPrune) {
    await unlink(join(dir, name));
    console.log(`backup: pruned ${name} (retention=${String(retentionCount)})`);
  }
}

main().catch((error: unknown) => {
  console.error('backup: failed', error);
  process.exitCode = 1;
});
