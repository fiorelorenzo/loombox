import { Pool } from 'pg';

import { assessRollback, runMigrations } from './migrate';
import { migrations } from './migrations';

/**
 * Runnable migration entry point (#96): `pnpm --filter @loombox/relay run
 * migrate` (or `migrate down`), driven by `DATABASE_URL`. Meant to run once
 * on relay boot / the Docker image entrypoint, ahead of `main.ts`. It is
 * idempotent, so re-running it there on every start is safe.
 *
 * Two more subcommands (issue #657), both actually called by
 * `scripts/deploy-prod.sh`'s `rollback()`, not just documentation:
 *
 * - `migrate list`, no `DATABASE_URL` needed, prints every migration THIS
 *   image's own `migrations.ts` knows about, `[{"id","reversible"}, ...]`.
 *   Run against the pre-deploy relay image via `docker run --entrypoint`
 *   (no live container required), it answers "how far does the rollback
 *   target's own code actually go".
 * - `migrate assess-rollback [targetId]`, prints a
 *   `RollbackAssessment` (`{"allowed","toRollBack","blockedBy"}`) and exits
 *   non-zero when `allowed` is false, so a caller that only checks the
 *   exit code (as `deploy-prod.sh` does) still refuses correctly without
 *   parsing JSON. Needs `DATABASE_URL`, run against the CURRENTLY LIVE
 *   relay, the one that actually knows what's applied.
 */
async function main(): Promise<void> {
  const subcommand = process.argv[2];

  if (subcommand === 'list') {
    console.log(JSON.stringify(migrations.map((m) => ({ id: m.id, reversible: m.reversible }))));
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('migrate: DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    if (subcommand === 'assess-rollback') {
      const targetId = process.argv[3] || undefined;
      const assessment = await assessRollback(pool, targetId);
      console.log(JSON.stringify(assessment));
      if (!assessment.allowed) {
        console.error(
          `migrate: refusing -- rolling back${targetId ? ` to ${targetId}` : ''} would leave irreversible migration(s) undone: ${assessment.blockedBy.join(', ')}`,
        );
        process.exitCode = 1;
      }
      return;
    }

    const direction = subcommand === 'down' ? 'down' : 'up';
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
