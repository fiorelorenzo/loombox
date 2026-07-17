import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';

import { migrations } from './migrations';
import { runMigrations } from './migrate';
import type { PgLike } from './pg-client';

function freshPg(): PgLike {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as PgLike;
}

describe('relay Postgres migrations (#96)', () => {
  it('applies every migration once, in order, tracked in _migrations', async () => {
    const pg = freshPg();
    const ran = await runMigrations(pg, 'up');
    expect(ran).toEqual(migrations.map((m) => m.id));

    const { rows } = await pg.query<{ id: string }>(`SELECT id FROM _migrations ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual([...migrations.map((m) => m.id)].sort());
  });

  it('is idempotent: running up twice applies nothing the second time', async () => {
    const pg = freshPg();
    await runMigrations(pg, 'up');
    const second = await runMigrations(pg, 'up');
    expect(second).toEqual([]);
  });

  it('creates the tables the store implementations read/write', async () => {
    const pg = freshPg();
    await runMigrations(pg, 'up');

    await pg.query(
      `INSERT INTO devices (device_id, device_public_key, account_id, registered_at, last_seen_at) VALUES ($1,$2,$3,$4,$5)`,
      ['d1', 'pk1', 'acct1', 1, 1],
    );
    await pg.query(
      `INSERT INTO sessions (session_id, node_id, target_id, account_id, provider, created_at, envelope_resource_id, envelope_iv, envelope_ciphertext, envelope_alg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ['s1', 'n1', 't1', 'acct1', 'claude', 1, 's1', 'iv', 'ct', 'AES-256-GCM'],
    );
    await pg.query(
      `INSERT INTO blobs (blob_key, envelope_resource_id, envelope_iv, envelope_ciphertext, envelope_alg) VALUES ($1,$2,$3,$4,$5)`,
      ['s1:ref', 's1', 'iv', 'ct', 'AES-256-GCM'],
    );

    const devices = await pg.query(`SELECT * FROM devices`);
    const sessions = await pg.query(`SELECT * FROM sessions`);
    const blobs = await pg.query(`SELECT * FROM blobs`);
    expect(devices.rows).toHaveLength(1);
    expect(sessions.rows).toHaveLength(1);
    expect(blobs.rows).toHaveLength(1);
  });

  it('rolls back every migration via down, in reverse order, dropping every table', async () => {
    const pg = freshPg();
    await runMigrations(pg, 'up');
    const down = await runMigrations(pg, 'down');
    expect(down).toEqual([...migrations.map((m) => m.id)].reverse());

    const { rows: trackedRows } = await pg.query(`SELECT id FROM _migrations`);
    expect(trackedRows).toHaveLength(0);

    const dropped = ['devices', 'sessions', 'session_seq_counters', 'session_rings', 'blobs'];
    for (const table of dropped) {
      const { rows } = await pg.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
        [table],
      );
      expect(rows, `${table} should have been dropped`).toHaveLength(0);
    }
  });
});
