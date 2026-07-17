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
