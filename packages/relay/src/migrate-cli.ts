import { Pool } from 'pg';

import { runMigrations } from './migrate';

/**
 * Runnable migration entry point (#96): `pnpm --filter @loombox/relay run
 * migrate` (or `migrate down`), driven by `DATABASE_URL`. Meant to run once
 * on relay boot / the Docker image entrypoint, ahead of `main.ts` — it is
 * idempotent, so re-running it there on every start is safe.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('migrate: DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const ran = await runMigrations(pool, direction);
    console.log(ran.length > 0 ? `migrate: applied ${ran.join(', ')}` : 'migrate: nothing to do');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('migrate: failed', error);
  process.exitCode = 1;
});
