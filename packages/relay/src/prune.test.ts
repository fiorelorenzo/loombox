import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import type { EncryptedEnvelope, SessionMetaPublic } from '@loombox/protocol';

import { runMigrations } from './migrate';
import type { PgLike } from './pg-client';
import { DEFAULT_RETENTION_MS, prune } from './prune';
import { createInMemoryRelayStore, type RelayStore } from './store';
import { createPostgresRelayStore } from './store-postgres';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeEnvelope(seed: string, resourceId = 'res'): EncryptedEnvelope {
  return {
    resourceId,
    iv: Buffer.from(`${seed}-iv`).toString('base64'),
    ciphertext: Buffer.from(`${seed}-ct`).toString('base64'),
    alg: 'AES-256-GCM',
  };
}

function makeSessionMeta(overrides: Partial<SessionMetaPublic> = {}): SessionMetaPublic {
  return {
    id: 'sess_1',
    nodeId: 'node_1',
    targetId: 'target_1',
    accountId: 'acct_1',
    provider: 'claude',
    createdAt: Date.now(),
    ...overrides,
  };
}

async function freshPgMemStore(): Promise<RelayStore> {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pg = new Pool() as unknown as PgLike;
  await runMigrations(pg, 'up');
  return createPostgresRelayStore(pg);
}

type MakeStore = () => Promise<RelayStore>;

const cases: Array<[string, MakeStore]> = [
  ['in-memory', () => Promise.resolve(createInMemoryRelayStore())],
  ['pg-mem (hermetic Postgres)', freshPgMemStore],
];

describe.each(cases)('relay data retention pruning (#102) — %s', (_label, makeStore) => {
  it('TTL-prunes a session older than the retention window, keeps one within it', async () => {
    const store = await makeStore();
    const now = Date.now();
    await store.sessions.announce({
      meta: makeSessionMeta({ id: 'sess_old', createdAt: now - 10_000 }),
      privateEnvelope: fakeEnvelope('old-title'),
    });
    await store.sessions.announce({
      meta: makeSessionMeta({ id: 'sess_new', createdAt: now - 1_000 }),
      privateEnvelope: fakeEnvelope('new-title'),
    });

    const report = await prune(store, { retentionMs: 5_000, now: () => now });

    expect(report).toMatchObject({ dryRun: false, expiredSessions: 1 });
    expect(await store.sessions.get('sess_old')).toBeUndefined();
    expect(await store.sessions.get('sess_new')).toBeDefined();
  });

  it('TTL-prunes a blob older than the retention window, keeps one within it', async () => {
    const store = await makeStore();

    await store.blobs.upload('sess_a:old', fakeEnvelope('old'), 'acct_1');
    // A small real gap before capturing the marker: the in-memory store
    // writes synchronously, so without this, 'old''s createdAt and
    // cutoffMarker can land in the very same millisecond and the strict `<`
    // TTL check below would (correctly) not treat it as expired yet.
    await sleep(5);
    const cutoffMarker = Date.now();
    await sleep(15);
    await store.blobs.upload('sess_a:new', fakeEnvelope('new'), 'acct_1');

    const report = await prune(store, { retentionMs: Date.now() - cutoffMarker });

    expect(report.expiredBlobs).toBe(1);
    expect(await store.blobs.download('sess_a:old')).toBeUndefined();
    expect(await store.blobs.download('sess_a:new')).toBeDefined();
  });

  it('is idempotent: a second TTL run finds nothing left to prune', async () => {
    const store = await makeStore();
    const now = Date.now();
    await store.sessions.announce({
      meta: makeSessionMeta({ id: 'sess_gone', createdAt: now - 10_000 }),
      privateEnvelope: fakeEnvelope('title'),
    });

    const first = await prune(store, { retentionMs: 5_000, now: () => now });
    expect(first.expiredSessions).toBe(1);

    const second = await prune(store, { retentionMs: 5_000, now: () => now });
    expect(second.expiredSessions).toBe(0);
    expect(second.expiredBlobs).toBe(0);
  });

  it('dry-run reports what would be pruned without deleting anything', async () => {
    const store = await makeStore();
    const now = Date.now();
    await store.sessions.announce({
      meta: makeSessionMeta({ id: 'sess_would_go', createdAt: now - 10_000 }),
      privateEnvelope: fakeEnvelope('title'),
    });

    const report = await prune(store, { retentionMs: 5_000, now: () => now, dryRun: true });

    expect(report).toMatchObject({ dryRun: true, expiredSessions: 1 });
    // still there — dry-run never deletes
    expect(await store.sessions.get('sess_would_go')).toBeDefined();
  });

  it('with no retentionMs/maxAccountBytes given, prunes nothing at all', async () => {
    const store = await makeStore();
    const now = Date.now();
    await store.sessions.announce({
      meta: makeSessionMeta({ id: 'sess_ancient', createdAt: now - 1_000_000_000 }),
      privateEnvelope: fakeEnvelope('title'),
    });

    const report = await prune(store);

    expect(report).toEqual({
      dryRun: false,
      expiredSessions: 0,
      expiredBlobs: 0,
      overCapBlobs: 0,
      overCapRingEntries: 0,
    });
    expect(await store.sessions.get('sess_ancient')).toBeDefined();
  });

  it('size-cap-prunes an over-budget account: oldest blobs first, then ring entries once blobs are exhausted', async () => {
    const store = await makeStore();
    await store.sessions.announce({
      meta: makeSessionMeta({ id: 'sess_cap', accountId: 'acct_cap' }),
      privateEnvelope: fakeEnvelope('title'),
    });

    // Two ~60-byte blobs, oldest first.
    await store.blobs.upload('sess_cap:b1', fakeEnvelope('b1-chunk-of-real-size'), 'acct_cap');
    await sleep(5);
    await store.blobs.upload('sess_cap:b2', fakeEnvelope('b2-chunk-of-real-size'), 'acct_cap');
    // Three ring entries.
    for (let seq = 1; seq <= 3; seq++) {
      await store.sessions.pushRingEntry(
        'sess_cap',
        { seq, envelope: fakeEnvelope(`ring-${seq}-padding-padding`) },
        'acct_cap',
      );
    }

    const usageBefore = await store.quota.getUsageBytes('acct_cap');
    expect(usageBefore).toBeGreaterThan(0);

    // Cap tight enough that pruning both blobs still isn't enough — it must
    // also reach into the ring entries.
    const maxAccountBytes = 40;
    const report = await prune(store, { maxAccountBytes });

    expect(report.overCapBlobs).toBe(2);
    expect(report.overCapRingEntries).toBeGreaterThan(0);
    expect(await store.blobs.download('sess_cap:b1')).toBeUndefined();
    expect(await store.blobs.download('sess_cap:b2')).toBeUndefined();
    expect(await store.quota.getUsageBytes('acct_cap')).toBeLessThanOrEqual(maxAccountBytes);
  });

  it('size-cap pass leaves an account under budget untouched', async () => {
    const store = await makeStore();
    await store.sessions.announce({
      meta: makeSessionMeta({ id: 'sess_fine', accountId: 'acct_fine' }),
      privateEnvelope: fakeEnvelope('title'),
    });
    await store.blobs.upload('sess_fine:b1', fakeEnvelope('small'), 'acct_fine');

    const report = await prune(store, { maxAccountBytes: 1_000_000 });

    expect(report.overCapBlobs).toBe(0);
    expect(report.overCapRingEntries).toBe(0);
    expect(await store.blobs.download('sess_fine:b1')).toBeDefined();
  });

  it('is idempotent: a second size-cap run over an already-pruned account does nothing more', async () => {
    const store = await makeStore();
    await store.sessions.announce({
      meta: makeSessionMeta({ id: 'sess_cap2', accountId: 'acct_cap2' }),
      privateEnvelope: fakeEnvelope('title'),
    });
    await store.blobs.upload('sess_cap2:b1', fakeEnvelope('a-decently-sized-chunk'), 'acct_cap2');

    const maxAccountBytes = 20;
    const first = await prune(store, { maxAccountBytes });
    expect(first.overCapBlobs).toBe(1);

    const second = await prune(store, { maxAccountBytes });
    expect(second.overCapBlobs).toBe(0);
    expect(second.overCapRingEntries).toBe(0);
  });
});

describe('DEFAULT_RETENTION_MS', () => {
  it('is a generous, multi-day default', () => {
    expect(DEFAULT_RETENTION_MS).toBeGreaterThan(30 * 24 * 60 * 60 * 1000);
  });
});

describe('relay data retention pruning (#102) — Postgres-only safety net', () => {
  it('never TTL- or size-cap-prunes a legacy blob row with no account_id/created_at (pre-#101/#102 migration data)', async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pg = new Pool() as unknown as PgLike;
    await runMigrations(pg, 'up');
    const store = createPostgresRelayStore(pg);

    // Simulates a blob written before the #101/#102 migration added these
    // columns: no account_id, no created_at.
    await pg.query(
      `INSERT INTO blobs (blob_key, envelope_resource_id, envelope_iv, envelope_ciphertext, envelope_alg)
       VALUES ($1,$2,$3,$4,$5)`,
      ['sess_legacy:ref', 'res', 'aXY=', 'AAAA', 'AES-256-GCM'],
    );

    const report = await prune(store, {
      retentionMs: 1,
      maxAccountBytes: 0,
      now: () => Date.now() + 1,
    });

    expect(report.expiredBlobs).toBe(0);
    expect(report.overCapBlobs).toBe(0);
    expect(await store.blobs.download('sess_legacy:ref')).toBeDefined();
  });
});
