import type { PgLike } from './pg-client';
import { migrations } from './migrations';

/**
 * Creates the `_migrations` bookkeeping table on first boot. Deliberately
 * checks `information_schema.tables` rather than `CREATE TABLE IF NOT
 * EXISTS ... (col PRIMARY KEY, ...)`: real Postgres supports that combo
 * fine, but `pg-mem` (the hermetic stand-in this file's own tests run
 * against) hits an internal AST-coverage limitation on the no-op path when
 * inline column constraints are involved — this check-then-create form
 * works identically against both.
 */
async function ensureMigrationsTable(pg: PgLike): Promise<void> {
  const { rows } = await pg.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_name = '_migrations'`,
  );
  if (rows.length > 0) return;
  await pg.query(`CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
}

/**
 * Applies (or rolls back) the relay's core-table migrations against `pg`
 * (#96). Tracks applied migration ids in `_migrations` so re-running is a
 * no-op — safe to call on every relay/Docker-entrypoint boot.
 */
export async function runMigrations(
  pg: PgLike,
  direction: 'up' | 'down' = 'up',
): Promise<string[]> {
  await ensureMigrationsTable(pg);
  const { rows } = await pg.query<{ id: string }>(`SELECT id FROM _migrations`);
  const applied = new Set(rows.map((row) => row.id));

  const ran: string[] = [];
  if (direction === 'up') {
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await pg.query(migration.up);
      await pg.query(`INSERT INTO _migrations (id, applied_at) VALUES ($1, $2)`, [
        migration.id,
        Date.now(),
      ]);
      ran.push(migration.id);
    }
  } else {
    for (const migration of [...migrations].reverse()) {
      if (!applied.has(migration.id)) continue;
      await pg.query(migration.down);
      await pg.query(`DELETE FROM _migrations WHERE id = $1`, [migration.id]);
      ran.push(migration.id);
    }
  }
  return ran;
}

/**
 * The result of asking whether it is safe to roll the schema back past
 * `targetId` (issue #657). `toRollBack` is every applied migration strictly
 * after the target, newest first — exactly the set `runMigrations(pg,
 * 'down')` would undo to reach that point. `blockedBy` is the subset of
 * those that are `reversible: false`; `allowed` is `blockedBy.length ===
 * 0`. A caller that overrides a refusal already has both lists in hand to
 * report honestly, rather than a bare boolean.
 */
export interface RollbackAssessment {
  allowed: boolean;
  toRollBack: string[];
  blockedBy: string[];
}

/**
 * Whether it is safe to roll the relay's schema back to (i.e. undo every
 * applied migration strictly after) `targetId` — the schema-side half of
 * `scripts/deploy-prod.sh`'s rollback (issue #657). `targetId` is normally
 * the last migration id the ROLLBACK-TARGET relay image's own
 * `migrations.ts` knows about (`migrate-cli.ts`'s `list` subcommand reads
 * that off the image with no DB involved); omitted, it means "roll back to
 * before this relay ran any migration at all".
 *
 * Reads `_migrations` for what is actually applied — never assumes the
 * full `migrations` array is, matching `runMigrations`' own "no-op unless
 * applied" contract, so a partially-migrated or freshly-seeded database is
 * assessed honestly rather than against a name it was fast-forwarded past.
 * Pure knowledge, never itself destructive: this never calls `down` —
 * `runMigrations(pg, 'down')` still does that, only after a caller has
 * checked `allowed` here (or made an informed decision to override it).
 * Classifying a migration `reversible: false` is not a ban, only a fact
 * this function surfaces instead of leaving to a comment no automation
 * reads.
 */
export async function assessRollback(pg: PgLike, targetId?: string): Promise<RollbackAssessment> {
  await ensureMigrationsTable(pg);

  const targetIndex = targetId ? migrations.findIndex((m) => m.id === targetId) : -1;
  if (targetId && targetIndex === -1) {
    throw new Error(`assessRollback: unknown target migration id "${targetId}"`);
  }

  const { rows } = await pg.query<{ id: string }>(`SELECT id FROM _migrations`);
  const applied = new Set(rows.map((row) => row.id));

  const afterTarget = migrations.filter((m, index) => index > targetIndex && applied.has(m.id));
  const toRollBack = [...afterTarget].reverse().map((m) => m.id);
  const blockedBy = afterTarget.filter((m) => !m.reversible).map((m) => m.id);

  return { allowed: blockedBy.length === 0, toRollBack, blockedBy };
}
