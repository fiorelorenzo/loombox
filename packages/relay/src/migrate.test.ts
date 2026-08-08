import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';

import { migrations } from './migrations';
import { assessRollback, runMigrations } from './migrate';
import type { PgLike } from './pg-client';

function freshPg(): PgLike {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as PgLike;
}

/**
 * Marks `_migrations` as applied only through `targetId`, a partially
 * migrated database, without depending on real `down` SQL to get there
 * (`assessRollback` only ever reads `_migrations`' bookkeeping rows, never
 * the schema itself, so deleting the later rows by hand is a faithful,
 * much cheaper stand-in for "this deploy never got that far").
 */
async function ensureAppliedThrough(pg: PgLike, targetId: string): Promise<void> {
  await runMigrations(pg, 'up');
  const targetIndex = migrations.findIndex((m) => m.id === targetId);
  for (const migration of migrations.slice(targetIndex + 1)) {
    await pg.query(`DELETE FROM _migrations WHERE id = $1`, [migration.id]);
  }
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

describe('assessRollback (#657: migration reversibility gate)', () => {
  it('allows a rollback whose undone set is entirely reversible', async () => {
    const pg = freshPg();
    await runMigrations(pg, 'up');

    // Everything after 0011_connected_accounts (0012, 0013) is reversible.
    const result = await assessRollback(pg, '0011_connected_accounts');
    expect(result).toEqual({
      allowed: true,
      toRollBack: ['0013_session_view_state', '0012_keymaps'],
      blockedBy: [],
    });
  });

  it('refuses a rollback that would cross the irreversible 0010_device_token_ids', async () => {
    const pg = freshPg();
    await runMigrations(pg, 'up');

    // Rolling back to 0009 would have to undo 0010 (irreversible) too.
    const result = await assessRollback(pg, '0009_device_auth');
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toEqual(['0010_device_token_ids']);
    expect(result.toRollBack).toContain('0010_device_token_ids');
  });

  it('refuses a full rollback (no target) once the irreversible migration is applied', async () => {
    const pg = freshPg();
    await runMigrations(pg, 'up');

    const result = await assessRollback(pg);
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toEqual(['0010_device_token_ids']);
    expect(result.toRollBack).toEqual([...migrations.map((m) => m.id)].reverse());
  });

  it('only weighs migrations actually applied, never the full static list', async () => {
    const pg = freshPg();
    // Apply nothing past 0009 by hand, mirroring a partially-migrated
    // database rather than assuming every deploy is fully caught up.
    await ensureAppliedThrough(pg, '0009_device_auth');

    const result = await assessRollback(pg);
    expect(result.allowed).toBe(true);
    expect(result.toRollBack).toEqual(
      migrations
        .slice(0, migrations.findIndex((m) => m.id === '0009_device_auth') + 1)
        .map((m) => m.id)
        .reverse(),
    );
  });

  it('is a no-op assessment (allowed, nothing to roll back) once the target is the latest applied migration', async () => {
    const pg = freshPg();
    await runMigrations(pg, 'up');

    const result = await assessRollback(pg, migrations[migrations.length - 1]!.id);
    expect(result).toEqual({ allowed: true, toRollBack: [], blockedBy: [] });
  });

  it('rejects an unknown target migration id rather than silently treating it as "roll back everything"', async () => {
    const pg = freshPg();
    await runMigrations(pg, 'up');

    await expect(assessRollback(pg, 'not_a_real_migration')).rejects.toThrow(
      /unknown target migration id/,
    );
  });

  it('never calls down itself, the applied set is unchanged after an assessment either way', async () => {
    const pg = freshPg();
    await runMigrations(pg, 'up');

    await assessRollback(pg, '0009_device_auth');

    const { rows } = await pg.query<{ id: string }>(`SELECT id FROM _migrations`);
    expect(rows).toHaveLength(migrations.length);
  });
});
