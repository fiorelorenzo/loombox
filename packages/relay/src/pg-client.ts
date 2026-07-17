/**
 * The minimal `pg.Pool` surface the relay's Postgres code depends on. Kept
 * narrow and structural (not `import type { Pool } from 'pg'` directly) so
 * `pg-mem`'s `db.adapters.createPg().Pool` — a pure-JS, hermetic stand-in
 * with the same runtime shape — satisfies it too, which is what makes the
 * Postgres store and migration runner unit-testable without Docker or a
 * live Postgres (#96, #99, #112).
 */
export interface PgQueryResult<Row> {
  rows: Row[];
}

export interface PgLike {
  query<Row = unknown>(text: string, params?: readonly unknown[]): Promise<PgQueryResult<Row>>;
}
