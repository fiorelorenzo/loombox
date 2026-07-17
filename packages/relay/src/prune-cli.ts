import { Pool } from 'pg';

import { DEFAULT_RETENTION_MS, prune } from './prune';
import { createPostgresRelayStore } from './store-postgres';

/**
 * Runnable retention entry point (#102): `pnpm --filter @loombox/relay
 * prune` (add `--dry-run` to preview without deleting), driven by
 * `DATABASE_URL`. Meant to run on a schedule (e.g. a nightly cron/systemd
 * timer alongside the backup job SPEC §9 calls for) — it's idempotent, so
 * running it more often than needed is always safe.
 *
 * `RELAY_RETENTION_MS` and `RELAY_ACCOUNT_STORAGE_QUOTA_BYTES` default to
 * the same values `main.ts`/`relay.ts` use for the write-time TTL/quota
 * (#101), so a self-hoster who only sets the quota env var once gets
 * consistent enforcement on both the write path and this reclaim path.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('prune: DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }

  const dryRun = process.argv.includes('--dry-run');
  const retentionMs = process.env.RELAY_RETENTION_MS
    ? Number(process.env.RELAY_RETENTION_MS)
    : DEFAULT_RETENTION_MS;
  const maxAccountBytes = process.env.RELAY_ACCOUNT_STORAGE_QUOTA_BYTES
    ? Number(process.env.RELAY_ACCOUNT_STORAGE_QUOTA_BYTES)
    : undefined;

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const store = createPostgresRelayStore(pool);
    const report = await prune(store, { retentionMs, maxAccountBytes, dryRun });
    console.log(
      `prune: ${dryRun ? '(dry run) ' : ''}` +
        `expired sessions=${report.expiredSessions} blobs=${report.expiredBlobs}; ` +
        `over-cap blobs=${report.overCapBlobs} ring entries=${report.overCapRingEntries}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('prune: failed', error);
  process.exitCode = 1;
});
