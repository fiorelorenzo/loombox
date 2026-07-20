import { newDb } from 'pg-mem';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './migrate';
import type { PgLike } from './pg-client';
import { createPostgresRelayStore } from './store-postgres';
import { createInMemoryRelayStore } from './store';
import type { RelayStore } from './store';

/**
 * Proves the Postgres store satisfies the exact same contract as the
 * in-memory one (round-trip device upsert/get/revoke, session announce +
 * account-scoped list isolation, blob upload/download, resync ring with
 * drop-oldest). Hermetic by default (`pg-mem`, no Docker); gated behind
 * `LOOMBOX_TEST_PG_URL` for an optional real-Postgres pass.
 */
async function freshPgMemStore(ringBufferSize?: number): Promise<RelayStore> {
  const db = newDb();
  const { Pool: MemPool } = db.adapters.createPg();
  const pg = new MemPool() as unknown as PgLike;
  await runMigrations(pg, 'up');
  return createPostgresRelayStore(pg, { ringBufferSize });
}

function fakeEnvelope(seed: string, resourceId = 'res') {
  return {
    resourceId,
    iv: Buffer.from(`${seed}-iv`).toString('base64'),
    ciphertext: Buffer.from(`${seed}-ct`).toString('base64'),
    alg: 'AES-256-GCM' as const,
  };
}

type MakeStore = (ringBufferSize?: number) => Promise<RelayStore>;

const cases: Array<[string, MakeStore]> = [
  ['pg-mem (hermetic)', (ringBufferSize) => freshPgMemStore(ringBufferSize)],
];
if (process.env.LOOMBOX_TEST_PG_URL) {
  const connectionString = process.env.LOOMBOX_TEST_PG_URL;
  cases.push([
    'real Postgres (LOOMBOX_TEST_PG_URL)',
    async (ringBufferSize) => {
      const pool = new Pool({ connectionString });
      await runMigrations(pool as unknown as PgLike, 'down');
      await runMigrations(pool as unknown as PgLike, 'up');
      return createPostgresRelayStore(pool as unknown as PgLike, { ringBufferSize });
    },
  ]);
}

describe.each(cases)('Postgres RelayStore (#96, #99, #112) — %s', (_label, makeStore) => {
  it('round-trips a device through upsert/get, then revoke', async () => {
    const store = await makeStore();
    const created = await store.devices.upsert({
      deviceId: 'dev_1',
      devicePublicKey: 'pk1',
      accountId: 'acct_1',
      label: 'phone',
    });
    expect(created.status).toBe('active');
    expect(created.deviceId).toBe('dev_1');

    const fetched = await store.devices.get('dev_1');
    expect(fetched).toMatchObject({
      deviceId: 'dev_1',
      devicePublicKey: 'pk1',
      accountId: 'acct_1',
      label: 'phone',
      status: 'active',
    });

    // upsert again (reconnect) preserves the original registeredAt but bumps lastSeenAt
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reconnected = await store.devices.upsert({
      deviceId: 'dev_1',
      devicePublicKey: 'pk1',
      accountId: 'acct_1',
    });
    expect(reconnected.registeredAt).toBe(created.registeredAt);
    expect(reconnected.lastSeenAt).toBeGreaterThanOrEqual(created.lastSeenAt);

    await store.devices.revoke('dev_1');
    const revoked = await store.devices.get('dev_1');
    expect(revoked?.status).toBe('revoked');
  });

  it('rotates a device public key', async () => {
    const store = await makeStore();
    await store.devices.upsert({
      deviceId: 'dev_2',
      devicePublicKey: 'pk-old',
      accountId: 'acct_1',
    });
    await store.devices.rotate('dev_2', 'pk-new');
    const record = await store.devices.get('dev_2');
    expect(record?.devicePublicKey).toBe('pk-new');
  });

  it('touch updates lastSeenAt without touching registeredAt', async () => {
    const store = await makeStore();
    const created = await store.devices.upsert({
      deviceId: 'dev_3',
      devicePublicKey: 'pk',
      accountId: 'acct_1',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.devices.touch('dev_3');
    const record = await store.devices.get('dev_3');
    expect(record?.registeredAt).toBe(created.registeredAt);
    expect(record?.lastSeenAt).toBeGreaterThanOrEqual(created.registeredAt);
  });

  it('announces a session and lists it only for the owning account, never a stranger', async () => {
    const store = await makeStore();
    const privateEnvelope = fakeEnvelope('secret-title');
    await store.sessions.announce({
      meta: {
        id: 'sess_a',
        nodeId: 'node_1',
        targetId: 'target_1',
        accountId: 'acct_1',
        provider: 'claude',
        createdAt: 1700000000000,
      },
      privateEnvelope,
    });

    const owned = await store.sessions.listForAccount('acct_1');
    expect(owned).toHaveLength(1);
    expect(owned[0]?.meta.id).toBe('sess_a');
    expect(owned[0]?.privateEnvelope).toEqual(privateEnvelope);

    const stranger = await store.sessions.listForAccount('acct_2');
    expect(stranger).toEqual([]);

    const fetched = await store.sessions.get('sess_a');
    expect(fetched?.meta.accountId).toBe('acct_1');
  });

  it('round-trips an uploaded ciphertext blob byte-for-byte by opaque ref', async () => {
    const store = await makeStore();
    const envelope = fakeEnvelope('totally-opaque', 'blob');
    await store.blobs.upload('sess_a:ref_1', envelope, 'acct_1');
    const downloaded = await store.blobs.download('sess_a:ref_1');
    expect(downloaded).toEqual(envelope);
    expect(await store.blobs.download('sess_a:ref_missing')).toBeUndefined();
  });

  it('assigns monotonically increasing seq numbers per session', async () => {
    const store = await makeStore();
    const first = await store.sessions.nextSeq('sess_seq');
    const second = await store.sessions.nextSeq('sess_seq');
    const third = await store.sessions.nextSeq('sess_seq');
    expect([first, second, third]).toEqual([1, 2, 3]);
    // a different session's counter is independent
    expect(await store.sessions.nextSeq('sess_seq_other')).toBe(1);
  });

  it('resync ring: drop-oldest under capacity, replay + dropped-range marker data since a given seq', async () => {
    const store = await makeStore(3);
    const envelopes = Array.from({ length: 5 }, (_, i) => fakeEnvelope(`chunk-${i + 1}`));
    for (let i = 0; i < envelopes.length; i++) {
      await store.sessions.pushRingEntry(
        'sess_ring',
        { seq: i + 1, envelope: envelopes[i] },
        'acct_1',
      );
    }

    const result = await store.sessions.getEntriesSince('sess_ring', 0);
    expect(result.droppedFromSeq).toBe(1);
    expect(result.droppedToSeq).toBe(2);
    expect(result.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(result.entries.map((e) => e.envelope)).toEqual([
      envelopes[2],
      envelopes[3],
      envelopes[4],
    ]);

    // asking from within the still-buffered range gets no dropped marker
    const partial = await store.sessions.getEntriesSince('sess_ring', 3);
    expect(partial.droppedFromSeq).toBeUndefined();
    expect(partial.entries.map((e) => e.seq)).toEqual([4, 5]);
  });

  it('getEntriesSince on a session with no ring yet returns an empty result', async () => {
    const store = await makeStore();
    const result = await store.sessions.getEntriesSince('sess_never_pushed', 0);
    expect(result).toEqual({ entries: [] });
  });

  it('round-trips an escrowed wrapped-AMK blob per account, and re-escrowing overwrites (#114/#115)', async () => {
    const store = await makeStore();
    expect(await store.escrow.get('acct_1')).toBeUndefined();

    await store.escrow.put('acct_1', 'opaque-wrapped-amk-v1');
    expect(await store.escrow.get('acct_1')).toBe('opaque-wrapped-amk-v1');
    // a different account never sees acct_1's blob
    expect(await store.escrow.get('acct_2')).toBeUndefined();

    await store.escrow.put('acct_1', 'opaque-wrapped-amk-v2');
    expect(await store.escrow.get('acct_1')).toBe('opaque-wrapped-amk-v2');
  });

  it('AMK epoch rotation (#116): epoch advances only by exactly one, and pending envelopes are per (account, device)', async () => {
    const store = await makeStore();
    expect(await store.amkRotation.getCurrentEpoch('acct_1')).toBe(0);

    // Skipping straight to epoch 2 without ever advancing to 1 is rejected.
    expect(await store.amkRotation.advanceEpoch('acct_1', 2)).toBe(false);
    expect(await store.amkRotation.getCurrentEpoch('acct_1')).toBe(0);

    expect(await store.amkRotation.advanceEpoch('acct_1', 1)).toBe(true);
    expect(await store.amkRotation.getCurrentEpoch('acct_1')).toBe(1);
    // A second account's epoch is untouched.
    expect(await store.amkRotation.getCurrentEpoch('acct_2')).toBe(0);

    expect(await store.amkRotation.getPending('acct_1', 'dev_survivor')).toBeUndefined();
    await store.amkRotation.putPending('acct_1', 'dev_survivor', {
      epoch: 1,
      fromDeviceId: 'dev_actor',
      envelope: fakeEnvelope(
        'rewrapped-amk-epoch-1',
        'loombox-amk-rotation-v1:acct_1:dev_survivor:1',
      ),
    });
    const pending = await store.amkRotation.getPending('acct_1', 'dev_survivor');
    expect(pending?.epoch).toBe(1);
    expect(pending?.fromDeviceId).toBe('dev_actor');
    expect(pending?.envelope).toEqual(
      fakeEnvelope('rewrapped-amk-epoch-1', 'loombox-amk-rotation-v1:acct_1:dev_survivor:1'),
    );
    // A different account never sees this device's pending envelope even
    // under the same device id.
    expect(await store.amkRotation.getPending('acct_2', 'dev_survivor')).toBeUndefined();

    // A later revoke's wrap-fan-out overwrites this device's pending entry
    // rather than accumulating.
    expect(await store.amkRotation.advanceEpoch('acct_1', 2)).toBe(true);
    await store.amkRotation.putPending('acct_1', 'dev_survivor', {
      epoch: 2,
      fromDeviceId: 'dev_actor_2',
      envelope: fakeEnvelope(
        'rewrapped-amk-epoch-2',
        'loombox-amk-rotation-v1:acct_1:dev_survivor:2',
      ),
    });
    const updated = await store.amkRotation.getPending('acct_1', 'dev_survivor');
    expect(updated?.epoch).toBe(2);
    expect(updated?.fromDeviceId).toBe('dev_actor_2');
  });

  it('round-trips a push subscription per (account, device), scoped by account, and re-subscribing the same device overwrites (#161/#163)', async () => {
    const store = await makeStore();
    expect(await store.pushSubscriptions.get('acct_1', 'dev_1')).toBeUndefined();

    await store.pushSubscriptions.save({
      accountId: 'acct_1',
      deviceId: 'dev_1',
      endpoint: 'https://push.example/ep1',
      p256dh: 'p256dh-1',
      auth: 'auth-1',
    });
    const saved = await store.pushSubscriptions.get('acct_1', 'dev_1');
    expect(saved?.endpoint).toBe('https://push.example/ep1');

    // a second account's own device is never returned by another account's listing
    await store.pushSubscriptions.save({
      accountId: 'acct_2',
      deviceId: 'dev_2',
      endpoint: 'https://push.example/ep2',
      p256dh: 'p256dh-2',
      auth: 'auth-2',
    });
    expect((await store.pushSubscriptions.listForAccount('acct_1')).map((r) => r.deviceId)).toEqual(
      ['dev_1'],
    );

    // re-subscribing the same (account, device) overwrites rather than accumulating
    await store.pushSubscriptions.save({
      accountId: 'acct_1',
      deviceId: 'dev_1',
      endpoint: 'https://push.example/ep1-rotated',
      p256dh: 'p256dh-1b',
      auth: 'auth-1b',
    });
    expect(await store.pushSubscriptions.listForAccount('acct_1')).toHaveLength(1);
    expect((await store.pushSubscriptions.get('acct_1', 'dev_1'))?.endpoint).toBe(
      'https://push.example/ep1-rotated',
    );

    await store.pushSubscriptions.delete('acct_1', 'dev_1');
    expect(await store.pushSubscriptions.get('acct_1', 'dev_1')).toBeUndefined();
    // deleting an already-gone pair is a no-op, not an error
    await store.pushSubscriptions.delete('acct_1', 'dev_1');
  });

  it('persists a VAPID keypair once, and a later saveIfAbsent call never overwrites it (#161)', async () => {
    const store = await makeStore();
    expect(await store.vapidKeys.get()).toBeUndefined();

    const first = await store.vapidKeys.saveIfAbsent({ publicKey: 'pub-1', privateKey: 'priv-1' });
    expect(first).toEqual({ publicKey: 'pub-1', privateKey: 'priv-1' });
    expect(await store.vapidKeys.get()).toEqual({ publicKey: 'pub-1', privateKey: 'priv-1' });

    // a second call (e.g. a concurrent boot) never replaces the stored keypair
    const second = await store.vapidKeys.saveIfAbsent({ publicKey: 'pub-2', privateKey: 'priv-2' });
    expect(second).toEqual({ publicKey: 'pub-1', privateKey: 'priv-1' });
    expect(await store.vapidKeys.get()).toEqual({ publicKey: 'pub-1', privateKey: 'priv-1' });
  });
});

describe('Postgres store matches the in-memory store contract shape', () => {
  it('both implementations satisfy RelayStore with the same behavior for a simple round trip', async () => {
    const pgStore = await freshPgMemStore();
    const memStore = createInMemoryRelayStore();

    for (const store of [pgStore, memStore]) {
      await store.devices.upsert({ deviceId: 'd', devicePublicKey: 'pk', accountId: 'a' });
      expect((await store.devices.get('d'))?.accountId).toBe('a');
      await store.devices.revoke('d');
      expect((await store.devices.get('d'))?.status).toBe('revoked');
    }
  });
});
