import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { runPgDump, runPgRestore } from './backup';
import { decryptBackup, encryptBackup } from './backup-crypto';
import { runMigrations } from './migrate';
import type { PgLike } from './pg-client';
import { createPostgresRelayStore } from './store-postgres';

/**
 * The real dump -> encrypt -> decrypt -> restore round trip against a live
 * Postgres (#103's acceptance: "restore runbook... executed once against a
 * scratch Postgres to confirm it actually restores"). Skipped by default
 * (heavy: two throwaway databases + two real `pg_dump`/`pg_restore`
 * process spawns) — set `LOOMBOX_TEST_PG_URL` to run it, following the same
 * convention `store-postgres.test.ts` already uses for its optional
 * real-Postgres pass.
 *
 * To run locally:
 *   docker run --rm -d -p 15599:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
 *   LOOMBOX_TEST_PG_URL=postgresql://postgres:postgres@127.0.0.1:15599/postgres \
 *     pnpm --filter @loombox/relay exec vitest run src/backup-restore.integration.test.ts
 *
 * `pg_dump`/`pg_restore` themselves are invoked through a `docker run
 * --network host postgres:16-alpine` wrapper rather than assuming a
 * matching client binary is on this machine's `PATH` — see `backup.ts`'s
 * module doc comment. `--network host` lets that throwaway container reach
 * whatever host/port `LOOMBOX_TEST_PG_URL` points at (the same trick works
 * whether that Postgres is itself dockerized, as in the example above, or a
 * native install). Production (`backup-cli.ts`/`restore-cli.ts`) defaults to
 * the bare binaries instead; see `docs/relay-backup.md`.
 */
const RUN_INTEGRATION = Boolean(process.env.LOOMBOX_TEST_PG_URL);
const DOCKER_PG_DUMP = [
  'docker',
  'run',
  '--rm',
  '--network',
  'host',
  'postgres:16-alpine',
  'pg_dump',
];
const DOCKER_PG_RESTORE = [
  'docker',
  'run',
  '--rm',
  '-i',
  '--network',
  'host',
  'postgres:16-alpine',
  'pg_restore',
];

describe.skipIf(!RUN_INTEGRATION)('relay backup/restore — live Postgres round trip (#103)', () => {
  const adminUrl = process.env.LOOMBOX_TEST_PG_URL ?? '';
  const suffix = randomBytes(4).toString('hex');
  const srcDbName = `relay_backup_test_src_${suffix}`;
  const targetDbName = `relay_backup_test_target_${suffix}`;
  const dbUrl = (name: string) => adminUrl.replace(/\/[^/?]+(\?.*)?$/, `/${name}$1`);

  const cleanup: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });

  it('dumps a seeded database, encrypts, decrypts, restores into a fresh database, and round-trips the row', async () => {
    const admin = new Pool({ connectionString: adminUrl });
    cleanup.push(async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${srcDbName}`);
      await admin.query(`DROP DATABASE IF EXISTS ${targetDbName}`);
      await admin.end();
    });
    await admin.query(`CREATE DATABASE ${srcDbName}`);
    await admin.query(`CREATE DATABASE ${targetDbName}`);

    const srcUrl = dbUrl(srcDbName);
    const targetUrl = dbUrl(targetDbName);

    const srcPool = new Pool({ connectionString: srcUrl });
    cleanup.push(async () => srcPool.end());
    await runMigrations(srcPool as unknown as PgLike, 'up');

    const store = createPostgresRelayStore(srcPool as unknown as PgLike);
    const seededDevice = await store.devices.upsert({
      deviceId: 'dev_backup_roundtrip',
      devicePublicKey: 'pk-roundtrip',
      accountId: 'acct_roundtrip',
      label: 'the seeded row',
    });

    // Dump the source database (real pg_dump), encrypt, decrypt (proving the
    // encryption round trip against a real artifact, not just synthetic
    // bytes), then restore into the empty target database (real pg_restore).
    const key = randomBytes(32);
    const dump = await runPgDump({ databaseUrl: srcUrl, command: DOCKER_PG_DUMP });
    const encrypted = encryptBackup(dump, key);
    const decrypted = decryptBackup(encrypted, key);
    await runPgRestore({ databaseUrl: targetUrl, dump: decrypted, command: DOCKER_PG_RESTORE });

    // Assert the seeded row round-tripped into the restored database.
    const targetPool = new Pool({ connectionString: targetUrl });
    cleanup.push(async () => targetPool.end());
    const restoredStore = createPostgresRelayStore(targetPool as unknown as PgLike);
    const restoredDevice = await restoredStore.devices.get('dev_backup_roundtrip');

    expect(restoredDevice).toEqual(seededDevice);
  }, 120_000);
});
