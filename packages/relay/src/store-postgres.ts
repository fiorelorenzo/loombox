import type { EncryptedEnvelope, SessionMetaPublic } from '@loombox/protocol';

import type { PgLike } from './pg-client';
import {
  createTargetStore,
  envelopeByteSize,
  type AmkRotationPending,
  type AmkRotationStore,
  type BlobRetentionMeta,
  type BlobStore,
  type DeviceAuthRequestRecord,
  type DeviceAuthStore,
  type DeviceRecord,
  type DeviceStore,
  type DeviceTokenStore,
  type EscrowStore,
  type LeaseGrantOutcome,
  type LeaseRecord,
  type LeaseStore,
  type PushSubscriptionRecord,
  type PushSubscriptionStore,
  type QuotaStore,
  type RelayStore,
  type RelayStoreOptions,
  type ResyncResult,
  type RingEntry,
  type RingEntryRetentionMeta,
  type SessionRecord,
  type SessionStore,
  type VapidKeyPair,
  type VapidKeyStore,
} from './store';

/**
 * Postgres-backed `RelayStore` (#96 schema, #112 device registry, #99 blob
 * store, session store + resync ring persistence). Implements the exact
 * `DeviceStore`/`SessionStore`/`BlobStore` interfaces `store.ts` declares —
 * see that file's module doc comment for why their methods return
 * `Awaitable<T>` rather than a bare value. `TargetStore` is not persisted
 * here (still `createTargetStore()`, in-memory) for the same reason.
 *
 * Takes a `PgLike` rather than importing `pg`'s `Pool` type directly, so the
 * hermetic test suite (`store-postgres.test.ts`) can hand it a `pg-mem`
 * in-memory Postgres instead of a real one — both satisfy the same
 * structural `{ query(text, params) }` shape.
 */
export function createPostgresRelayStore(pg: PgLike, opts: RelayStoreOptions = {}): RelayStore {
  return {
    devices: createPostgresDeviceStore(pg),
    targets: createTargetStore(),
    sessions: createPostgresSessionStore(pg, opts.ringBufferSize ?? 200),
    blobs: createPostgresBlobStore(pg),
    quota: createPostgresQuotaStore(pg),
    escrow: createPostgresEscrowStore(pg),
    amkRotation: createPostgresAmkRotationStore(pg),
    pushSubscriptions: createPostgresPushSubscriptionStore(pg),
    vapidKeys: createPostgresVapidKeyStore(pg),
    leases: createPostgresLeaseStore(pg),
    deviceAuth: createPostgresDeviceAuthStore(pg),
    deviceTokens: createPostgresDeviceTokenStore(pg),
  };
}

function rowToDevice(row: {
  device_id: string;
  device_public_key: string;
  label: string | null;
  account_id: string;
  status: string;
  registered_at: string | number;
  last_seen_at: string | number;
}): DeviceRecord {
  return {
    deviceId: row.device_id,
    devicePublicKey: row.device_public_key,
    label: row.label ?? undefined,
    accountId: row.account_id,
    status: row.status === 'revoked' ? 'revoked' : 'active',
    registeredAt: Number(row.registered_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

function createPostgresDeviceStore(pg: PgLike): DeviceStore {
  async function get(deviceId: string): Promise<DeviceRecord | undefined> {
    const { rows } = await pg.query(`SELECT * FROM devices WHERE device_id = $1`, [deviceId]);
    const row = rows[0] as Parameters<typeof rowToDevice>[0] | undefined;
    return row ? rowToDevice(row) : undefined;
  }

  return {
    async upsert(input) {
      const now = Date.now();
      const { rows: existingRows } = await pg.query<{ registered_at: string | number }>(
        `SELECT registered_at FROM devices WHERE device_id = $1`,
        [input.deviceId],
      );
      const registeredAt = existingRows[0] ? Number(existingRows[0].registered_at) : now;

      await pg.query(
        `INSERT INTO devices (device_id, device_public_key, label, account_id, status, registered_at, last_seen_at)
         VALUES ($1, $2, $3, $4, COALESCE((SELECT status FROM devices WHERE device_id = $1), 'active'), $5, $6)
         ON CONFLICT (device_id) DO UPDATE SET
           device_public_key = EXCLUDED.device_public_key,
           label = EXCLUDED.label,
           account_id = EXCLUDED.account_id,
           last_seen_at = EXCLUDED.last_seen_at`,
        [
          input.deviceId,
          input.devicePublicKey,
          input.label ?? null,
          input.accountId,
          registeredAt,
          now,
        ],
      );
      const record = await get(input.deviceId);
      // The row we just wrote always exists; this is only unreachable if the driver misbehaves.
      if (!record)
        throw new Error(`postgres device store: upsert of ${input.deviceId} did not persist`);
      return record;
    },
    get,
    async touch(deviceId) {
      await pg.query(`UPDATE devices SET last_seen_at = $2 WHERE device_id = $1`, [
        deviceId,
        Date.now(),
      ]);
    },
    async revoke(deviceId) {
      await pg.query(`UPDATE devices SET status = 'revoked' WHERE device_id = $1`, [deviceId]);
    },
    async rotate(deviceId, newDevicePublicKey) {
      await pg.query(`UPDATE devices SET device_public_key = $2 WHERE device_id = $1`, [
        deviceId,
        newDevicePublicKey,
      ]);
    },
  };
}

function envelopeColumns(envelope: EncryptedEnvelope): [string, string, string, string] {
  return [envelope.resourceId, envelope.iv, envelope.ciphertext, envelope.alg];
}

function rowToEnvelope(row: {
  envelope_resource_id: string;
  envelope_iv: string;
  envelope_ciphertext: string;
  envelope_alg: string;
}): EncryptedEnvelope {
  return {
    resourceId: row.envelope_resource_id,
    iv: row.envelope_iv,
    ciphertext: row.envelope_ciphertext,
    alg: row.envelope_alg as EncryptedEnvelope['alg'],
  };
}

function rowToSessionMeta(row: {
  session_id: string;
  node_id: string;
  target_id: string;
  account_id: string;
  provider: string;
  created_at: string | number;
}): SessionMetaPublic {
  return {
    id: row.session_id,
    nodeId: row.node_id,
    targetId: row.target_id,
    accountId: row.account_id,
    provider: row.provider,
    createdAt: Number(row.created_at),
  };
}

interface SessionRow {
  session_id: string;
  node_id: string;
  target_id: string;
  account_id: string;
  provider: string;
  created_at: string | number;
  envelope_resource_id: string;
  envelope_iv: string;
  envelope_ciphertext: string;
  envelope_alg: string;
}

function rowToSessionRecord(row: SessionRow): SessionRecord {
  return { meta: rowToSessionMeta(row), privateEnvelope: rowToEnvelope(row) };
}

function createPostgresSessionStore(pg: PgLike, defaultCapacity: number): SessionStore {
  return {
    async announce(record) {
      const [resourceId, iv, ciphertext, alg] = envelopeColumns(record.privateEnvelope);
      await pg.query(
        `INSERT INTO sessions (session_id, node_id, target_id, account_id, provider, created_at, envelope_resource_id, envelope_iv, envelope_ciphertext, envelope_alg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (session_id) DO UPDATE SET
           node_id = EXCLUDED.node_id,
           target_id = EXCLUDED.target_id,
           account_id = EXCLUDED.account_id,
           provider = EXCLUDED.provider,
           envelope_resource_id = EXCLUDED.envelope_resource_id,
           envelope_iv = EXCLUDED.envelope_iv,
           envelope_ciphertext = EXCLUDED.envelope_ciphertext,
           envelope_alg = EXCLUDED.envelope_alg`,
        [
          record.meta.id,
          record.meta.nodeId,
          record.meta.targetId,
          record.meta.accountId,
          record.meta.provider,
          record.meta.createdAt,
          resourceId,
          iv,
          ciphertext,
          alg,
        ],
      );
    },
    async get(sessionId) {
      const { rows } = await pg.query<SessionRow>(`SELECT * FROM sessions WHERE session_id = $1`, [
        sessionId,
      ]);
      return rows[0] ? rowToSessionRecord(rows[0]) : undefined;
    },
    async listForAccount(accountId) {
      const { rows } = await pg.query<SessionRow>(`SELECT * FROM sessions WHERE account_id = $1`, [
        accountId,
      ]);
      return rows.map(rowToSessionRecord);
    },
    async listAllMeta() {
      const { rows } = await pg.query<SessionRow>(`SELECT * FROM sessions`);
      return rows.map(rowToSessionMeta);
    },
    async deleteSession(sessionId) {
      await pg.query(`DELETE FROM session_ring_entries WHERE session_id = $1`, [sessionId]);
      await pg.query(`DELETE FROM session_rings WHERE session_id = $1`, [sessionId]);
      await pg.query(`DELETE FROM session_seq_counters WHERE session_id = $1`, [sessionId]);
      await pg.query(`DELETE FROM sessions WHERE session_id = $1`, [sessionId]);
    },
    async nextSeq(sessionId) {
      const { rows } = await pg.query<{ seq: number }>(
        `SELECT seq FROM session_seq_counters WHERE session_id = $1`,
        [sessionId],
      );
      const next = (rows[0]?.seq ?? 0) + 1;
      if (rows.length > 0) {
        await pg.query(`UPDATE session_seq_counters SET seq = $2 WHERE session_id = $1`, [
          sessionId,
          next,
        ]);
      } else {
        await pg.query(`INSERT INTO session_seq_counters (session_id, seq) VALUES ($1, $2)`, [
          sessionId,
          next,
        ]);
      }
      return next;
    },
    // `accountId` is unused here: usage/retention queries below join
    // `session_ring_entries` to `sessions.account_id` instead of
    // denormalizing the account onto every ring-entry row (the in-memory
    // store, which has no such join available, tracks it directly — see
    // `store.ts`'s `StoredRingEntry`). Kept as a parameter so both
    // implementations satisfy the exact same `SessionStore` signature.
    async pushRingEntry(sessionId, entry, _accountId) {
      const { rows: ringRows } = await pg.query<{
        capacity: number;
        last_evicted_seq: number | null;
      }>(`SELECT capacity, last_evicted_seq FROM session_rings WHERE session_id = $1`, [sessionId]);
      const capacity = ringRows[0]?.capacity ?? defaultCapacity;
      if (ringRows.length === 0) {
        await pg.query(
          `INSERT INTO session_rings (session_id, capacity, last_evicted_seq) VALUES ($1, $2, NULL)`,
          [sessionId, capacity],
        );
      }

      const [resourceId, iv, ciphertext, alg] = envelopeColumns(entry.envelope);
      await pg.query(
        `INSERT INTO session_ring_entries (session_id, seq, envelope_resource_id, envelope_iv, envelope_ciphertext, envelope_alg)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sessionId, entry.seq, resourceId, iv, ciphertext, alg],
      );

      const { rows: countRows } = await pg.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM session_ring_entries WHERE session_id = $1`,
        [sessionId],
      );
      let overflow = Number(countRows[0]?.count ?? 0) - capacity;
      let lastEvicted: number | undefined;
      while (overflow > 0) {
        const { rows: oldestRows } = await pg.query<{ seq: number }>(
          `SELECT seq FROM session_ring_entries WHERE session_id = $1 ORDER BY seq ASC LIMIT 1`,
          [sessionId],
        );
        const oldest = oldestRows[0];
        if (!oldest) break;
        await pg.query(`DELETE FROM session_ring_entries WHERE session_id = $1 AND seq = $2`, [
          sessionId,
          oldest.seq,
        ]);
        lastEvicted = oldest.seq;
        overflow -= 1;
      }
      if (lastEvicted !== undefined) {
        await pg.query(`UPDATE session_rings SET last_evicted_seq = $2 WHERE session_id = $1`, [
          sessionId,
          lastEvicted,
        ]);
      }
    },
    async getEntriesSince(sessionId, sinceSeq): Promise<ResyncResult> {
      const { rows: ringRows } = await pg.query<{ last_evicted_seq: number | null }>(
        `SELECT last_evicted_seq FROM session_rings WHERE session_id = $1`,
        [sessionId],
      );
      const lastEvictedSeq = ringRows[0]?.last_evicted_seq ?? undefined;

      const { rows: entryRows } = await pg.query<{
        seq: number;
        envelope_resource_id: string;
        envelope_iv: string;
        envelope_ciphertext: string;
        envelope_alg: string;
      }>(`SELECT * FROM session_ring_entries WHERE session_id = $1 AND seq > $2 ORDER BY seq ASC`, [
        sessionId,
        sinceSeq,
      ]);
      const entries: RingEntry[] = entryRows.map((row) => ({
        seq: row.seq,
        envelope: rowToEnvelope(row),
      }));

      if (lastEvictedSeq !== undefined && sinceSeq < lastEvictedSeq) {
        return { entries, droppedFromSeq: sinceSeq + 1, droppedToSeq: lastEvictedSeq };
      }
      return { entries };
    },
    async listRingEntriesForRetention() {
      const { rows } = await pg.query<{
        session_id: string;
        seq: number;
        account_id: string;
        envelope_resource_id: string;
        envelope_iv: string;
        envelope_ciphertext: string;
        envelope_alg: string;
      }>(
        `SELECT sre.session_id, sre.seq, s.account_id,
                sre.envelope_resource_id, sre.envelope_iv, sre.envelope_ciphertext, sre.envelope_alg
         FROM session_ring_entries sre
         JOIN sessions s ON s.session_id = sre.session_id`,
      );
      return rows.map((row): RingEntryRetentionMeta => ({
        sessionId: row.session_id,
        accountId: row.account_id,
        seq: row.seq,
        bytes: envelopeByteSize(rowToEnvelope(row)),
      }));
    },
    async pruneRingEntriesThrough(sessionId, throughSeq) {
      const { rows: toDelete } = await pg.query<{ seq: number }>(
        `SELECT seq FROM session_ring_entries WHERE session_id = $1 AND seq <= $2`,
        [sessionId, throughSeq],
      );
      if (toDelete.length === 0) return 0;

      await pg.query(`DELETE FROM session_ring_entries WHERE session_id = $1 AND seq <= $2`, [
        sessionId,
        throughSeq,
      ]);

      const maxDeletedSeq = Math.max(...toDelete.map((row) => row.seq));
      const { rows: ringRows } = await pg.query<{ last_evicted_seq: number | null }>(
        `SELECT last_evicted_seq FROM session_rings WHERE session_id = $1`,
        [sessionId],
      );
      const currentLastEvicted = ringRows[0]?.last_evicted_seq ?? undefined;
      const nextLastEvicted =
        currentLastEvicted === undefined
          ? maxDeletedSeq
          : Math.max(currentLastEvicted, maxDeletedSeq);
      await pg.query(`UPDATE session_rings SET last_evicted_seq = $2 WHERE session_id = $1`, [
        sessionId,
        nextLastEvicted,
      ]);
      return toDelete.length;
    },
  };
}

interface BlobRow {
  blob_key: string;
  account_id: string | null;
  created_at: string | number | null;
  envelope_resource_id: string;
  envelope_iv: string;
  envelope_ciphertext: string;
  envelope_alg: string;
}

function createPostgresBlobStore(pg: PgLike): BlobStore {
  return {
    async upload(key, envelope, accountId) {
      const [resourceId, iv, ciphertext, alg] = envelopeColumns(envelope);
      await pg.query(
        `INSERT INTO blobs (blob_key, account_id, created_at, envelope_resource_id, envelope_iv, envelope_ciphertext, envelope_alg)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (blob_key) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           created_at = EXCLUDED.created_at,
           envelope_resource_id = EXCLUDED.envelope_resource_id,
           envelope_iv = EXCLUDED.envelope_iv,
           envelope_ciphertext = EXCLUDED.envelope_ciphertext,
           envelope_alg = EXCLUDED.envelope_alg`,
        [key, accountId, Date.now(), resourceId, iv, ciphertext, alg],
      );
    },
    async download(key) {
      const { rows } = await pg.query(`SELECT * FROM blobs WHERE blob_key = $1`, [key]);
      const row = rows[0] as Parameters<typeof rowToEnvelope>[0] | undefined;
      return row ? rowToEnvelope(row) : undefined;
    },
    async listForRetention() {
      const { rows } = await pg.query<BlobRow>(`SELECT * FROM blobs`);
      return rows.map((row): BlobRetentionMeta => ({
        key: row.blob_key,
        // A NULL `account_id` (pre-#101-migration row) is charged to no
        // one — see `migrations.ts`'s `0004_blob_quota_retention` comment.
        accountId: row.account_id ?? '',
        bytes: envelopeByteSize(rowToEnvelope(row)),
        createdAt: row.created_at === null ? undefined : Number(row.created_at),
      }));
    },
    async delete(key) {
      await pg.query(`DELETE FROM blobs WHERE blob_key = $1`, [key]);
    },
  };
}

function createPostgresEscrowStore(pg: PgLike): EscrowStore {
  return {
    async put(accountId, wrappedAmk) {
      await pg.query(
        `INSERT INTO amk_escrow (account_id, wrapped_amk, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET
           wrapped_amk = EXCLUDED.wrapped_amk,
           updated_at = EXCLUDED.updated_at`,
        [accountId, wrappedAmk, Date.now()],
      );
    },
    async get(accountId) {
      const { rows } = await pg.query<{ wrapped_amk: string }>(
        `SELECT wrapped_amk FROM amk_escrow WHERE account_id = $1`,
        [accountId],
      );
      return rows[0]?.wrapped_amk;
    },
  };
}

interface AmkRotationPendingRow {
  epoch: number;
  from_device_id: string;
  envelope_resource_id: string;
  envelope_iv: string;
  envelope_ciphertext: string;
  envelope_alg: string;
}

function rowToAmkRotationPending(row: AmkRotationPendingRow): AmkRotationPending {
  return {
    epoch: Number(row.epoch),
    fromDeviceId: row.from_device_id,
    envelope: rowToEnvelope(row),
  };
}

function createPostgresAmkRotationStore(pg: PgLike): AmkRotationStore {
  return {
    async getCurrentEpoch(accountId) {
      const { rows } = await pg.query<{ epoch: number }>(
        `SELECT epoch FROM amk_epochs WHERE account_id = $1`,
        [accountId],
      );
      return rows[0] ? Number(rows[0].epoch) : 0;
    },
    async advanceEpoch(accountId, newEpoch) {
      // Read-then-write: matches this store's other single-account counters
      // (no heavier transactional locking elsewhere in this package either).
      // A concurrent double-revoke race on the same account is a known,
      // accepted v1 limitation — see `store.ts`'s `AmkRotationStore` doc
      // comment.
      const { rows } = await pg.query<{ epoch: number }>(
        `SELECT epoch FROM amk_epochs WHERE account_id = $1`,
        [accountId],
      );
      const current = rows[0] ? Number(rows[0].epoch) : 0;
      if (newEpoch !== current + 1) return false;
      await pg.query(
        `INSERT INTO amk_epochs (account_id, epoch) VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET epoch = EXCLUDED.epoch`,
        [accountId, newEpoch],
      );
      return true;
    },
    async putPending(accountId, deviceId, pending) {
      const [resourceId, iv, ciphertext, alg] = envelopeColumns(pending.envelope);
      await pg.query(
        `INSERT INTO amk_rotation_pending (account_id, device_id, epoch, from_device_id, envelope_resource_id, envelope_iv, envelope_ciphertext, envelope_alg, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (account_id, device_id) DO UPDATE SET
           epoch = EXCLUDED.epoch,
           from_device_id = EXCLUDED.from_device_id,
           envelope_resource_id = EXCLUDED.envelope_resource_id,
           envelope_iv = EXCLUDED.envelope_iv,
           envelope_ciphertext = EXCLUDED.envelope_ciphertext,
           envelope_alg = EXCLUDED.envelope_alg,
           created_at = EXCLUDED.created_at`,
        [
          accountId,
          deviceId,
          pending.epoch,
          pending.fromDeviceId,
          resourceId,
          iv,
          ciphertext,
          alg,
          Date.now(),
        ],
      );
    },
    async getPending(accountId, deviceId) {
      const { rows } = await pg.query<AmkRotationPendingRow>(
        `SELECT epoch, from_device_id, envelope_resource_id, envelope_iv, envelope_ciphertext, envelope_alg
         FROM amk_rotation_pending WHERE account_id = $1 AND device_id = $2`,
        [accountId, deviceId],
      );
      return rows[0] ? rowToAmkRotationPending(rows[0]) : undefined;
    },
  };
}

interface PushSubscriptionRow {
  account_id: string;
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string | number;
}

function rowToPushSubscription(row: PushSubscriptionRow): PushSubscriptionRecord {
  return {
    accountId: row.account_id,
    deviceId: row.device_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: Number(row.created_at),
  };
}

function createPostgresPushSubscriptionStore(pg: PgLike): PushSubscriptionStore {
  return {
    async save(input) {
      const createdAt = Date.now();
      await pg.query(
        `INSERT INTO push_subscriptions (account_id, device_id, endpoint, p256dh, auth, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (account_id, device_id) DO UPDATE SET
           endpoint = EXCLUDED.endpoint,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           created_at = EXCLUDED.created_at`,
        [input.accountId, input.deviceId, input.endpoint, input.p256dh, input.auth, createdAt],
      );
      return { ...input, createdAt };
    },
    async get(accountId, deviceId) {
      const { rows } = await pg.query<PushSubscriptionRow>(
        `SELECT * FROM push_subscriptions WHERE account_id = $1 AND device_id = $2`,
        [accountId, deviceId],
      );
      return rows[0] ? rowToPushSubscription(rows[0]) : undefined;
    },
    async listForAccount(accountId) {
      const { rows } = await pg.query<PushSubscriptionRow>(
        `SELECT * FROM push_subscriptions WHERE account_id = $1`,
        [accountId],
      );
      return rows.map(rowToPushSubscription);
    },
    async delete(accountId, deviceId) {
      await pg.query(`DELETE FROM push_subscriptions WHERE account_id = $1 AND device_id = $2`, [
        accountId,
        deviceId,
      ]);
    },
  };
}

function createPostgresVapidKeyStore(pg: PgLike): VapidKeyStore {
  return {
    async get() {
      const { rows } = await pg.query<{ public_key: string; private_key: string }>(
        `SELECT public_key, private_key FROM vapid_keys WHERE id = 1`,
      );
      const row = rows[0];
      return row ? { publicKey: row.public_key, privateKey: row.private_key } : undefined;
    },
    async saveIfAbsent(keys: VapidKeyPair) {
      // #161: first-writer-wins across concurrent boots — `ON CONFLICT DO
      // NOTHING` means a losing race's INSERT is silently dropped, then the
      // SELECT below always returns whatever ended up stored (the winner's
      // row), never the loser's own `keys` argument.
      await pg.query(
        `INSERT INTO vapid_keys (id, public_key, private_key, created_at)
         VALUES (1, $1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [keys.publicKey, keys.privateKey, Date.now()],
      );
      const { rows } = await pg.query<{ public_key: string; private_key: string }>(
        `SELECT public_key, private_key FROM vapid_keys WHERE id = 1`,
      );
      const row = rows[0];
      if (!row) throw new Error('postgres vapid key store: saveIfAbsent did not persist a row');
      return { publicKey: row.public_key, privateKey: row.private_key };
    },
  };
}

interface LeaseRow {
  account_id: string;
  session_id: string;
  holder_node_id: string;
  expires_at: string | number;
}

function rowToLease(row: LeaseRow): LeaseRecord {
  return {
    accountId: row.account_id,
    sessionId: row.session_id,
    holderNodeId: row.holder_node_id,
    expiresAt: Number(row.expires_at),
  };
}

/**
 * Postgres-backed `LeaseStore` (issues #82/#104). Read-then-write, same
 * accepted-limitation trade-off `createPostgresAmkRotationStore` above
 * documents (no heavier transactional locking elsewhere in this package
 * either) — a concurrent double-acquire race on the exact same
 * (account, session) is not fully closed at the SQL level, but the relay
 * process is single-threaded per request so this only matters across two
 * relay processes racing the same millisecond, an accepted v1 gap.
 */
function createPostgresLeaseStore(pg: PgLike): LeaseStore {
  async function currentLease(
    accountId: string,
    sessionId: string,
  ): Promise<LeaseRecord | undefined> {
    const { rows } = await pg.query<LeaseRow>(
      `SELECT account_id, session_id, holder_node_id, expires_at FROM leases WHERE account_id = $1 AND session_id = $2`,
      [accountId, sessionId],
    );
    return rows[0] ? rowToLease(rows[0]) : undefined;
  }

  async function grant(
    accountId: string,
    sessionId: string,
    nodeId: string,
    ttlMs: number,
    now: number,
  ): Promise<LeaseGrantOutcome> {
    const expiresAt = now + ttlMs;
    await pg.query(
      `INSERT INTO leases (account_id, session_id, holder_node_id, expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (account_id, session_id) DO UPDATE SET
         holder_node_id = EXCLUDED.holder_node_id,
         expires_at = EXCLUDED.expires_at`,
      [accountId, sessionId, nodeId, expiresAt],
    );
    return { granted: true, lease: { accountId, sessionId, holderNodeId: nodeId, expiresAt } };
  }

  return {
    get: currentLease,
    async acquire(accountId, sessionId, nodeId, ttlMs, now) {
      const current = await currentLease(accountId, sessionId);
      if (current && current.holderNodeId !== nodeId && current.expiresAt > now) {
        return { granted: false, heldBy: current.holderNodeId, expiresAt: current.expiresAt };
      }
      return grant(accountId, sessionId, nodeId, ttlMs, now);
    },
    async renew(accountId, sessionId, nodeId, ttlMs, now) {
      const current = await currentLease(accountId, sessionId);
      if (!current || current.holderNodeId !== nodeId || current.expiresAt <= now) {
        return { granted: false, heldBy: current?.holderNodeId, expiresAt: current?.expiresAt };
      }
      return grant(accountId, sessionId, nodeId, ttlMs, now);
    },
    async release(accountId, sessionId, nodeId) {
      const current = await currentLease(accountId, sessionId);
      if (!current || current.holderNodeId !== nodeId) return false;
      await pg.query(`DELETE FROM leases WHERE account_id = $1 AND session_id = $2`, [
        accountId,
        sessionId,
      ]);
      return true;
    },
  };
}

function createPostgresQuotaStore(pg: PgLike): QuotaStore {
  return {
    async getUsageBytes(accountId) {
      const { rows: blobRows } = await pg.query<{
        envelope_resource_id: string;
        envelope_iv: string;
        envelope_ciphertext: string;
        envelope_alg: string;
      }>(
        `SELECT envelope_resource_id, envelope_iv, envelope_ciphertext, envelope_alg
         FROM blobs WHERE account_id = $1`,
        [accountId],
      );
      const blobBytes = blobRows.reduce(
        (sum, row) => sum + envelopeByteSize(rowToEnvelope(row)),
        0,
      );

      const { rows: ringRows } = await pg.query<{
        envelope_resource_id: string;
        envelope_iv: string;
        envelope_ciphertext: string;
        envelope_alg: string;
      }>(
        `SELECT sre.envelope_resource_id, sre.envelope_iv, sre.envelope_ciphertext, sre.envelope_alg
         FROM session_ring_entries sre
         JOIN sessions s ON s.session_id = sre.session_id
         WHERE s.account_id = $1`,
        [accountId],
      );
      const ringBytes = ringRows.reduce(
        (sum, row) => sum + envelopeByteSize(rowToEnvelope(row)),
        0,
      );

      return blobBytes + ringBytes;
    },
  };
}

interface DeviceAuthRequestRow {
  device_code_hash: string;
  user_code: string;
  status: string;
  account_id: string | null;
  pending_token: string | null;
  created_at: string | number;
  expires_at: string | number;
}

function rowToDeviceAuthRequest(row: DeviceAuthRequestRow): DeviceAuthRequestRecord {
  return {
    deviceCodeHash: row.device_code_hash,
    userCode: row.user_code,
    status: row.status === 'approved' || row.status === 'denied' ? row.status : 'pending',
    accountId: row.account_id ?? undefined,
    pendingToken: row.pending_token ?? undefined,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

/**
 * Postgres-backed `DeviceAuthStore` (issue #387). `approve`/`deny` are a
 * single conditional `UPDATE ... WHERE status = 'pending' AND expires_at >
 * $now`, so the not-found/expired/not-pending guard `store.ts`'s in-memory
 * implementation applies in application code is instead enforced by
 * Postgres itself here — a `RETURNING` clause with zero rows means the same
 * "no-op" outcome the in-memory store returns `undefined` for.
 */
function createPostgresDeviceAuthStore(pg: PgLike): DeviceAuthStore {
  return {
    async create(input) {
      await pg.query(
        `INSERT INTO device_auth_requests (device_code_hash, user_code, status, created_at, expires_at)
         VALUES ($1, $2, 'pending', $3, $4)`,
        [input.deviceCodeHash, input.userCode, input.createdAt, input.expiresAt],
      );
      return { ...input, status: 'pending' };
    },
    async getByDeviceCodeHash(deviceCodeHash) {
      const { rows } = await pg.query<DeviceAuthRequestRow>(
        `SELECT * FROM device_auth_requests WHERE device_code_hash = $1`,
        [deviceCodeHash],
      );
      return rows[0] ? rowToDeviceAuthRequest(rows[0]) : undefined;
    },
    async getByUserCode(userCode) {
      const { rows } = await pg.query<DeviceAuthRequestRow>(
        `SELECT * FROM device_auth_requests WHERE user_code = $1`,
        [userCode],
      );
      return rows[0] ? rowToDeviceAuthRequest(rows[0]) : undefined;
    },
    async approve(userCode, accountId, pendingToken, now) {
      const { rows } = await pg.query<DeviceAuthRequestRow>(
        `UPDATE device_auth_requests
         SET status = 'approved', account_id = $2, pending_token = $3
         WHERE user_code = $1 AND status = 'pending' AND expires_at >= $4
         RETURNING *`,
        [userCode, accountId, pendingToken, now],
      );
      return rows[0] ? rowToDeviceAuthRequest(rows[0]) : undefined;
    },
    async deny(userCode, now) {
      const { rows } = await pg.query<DeviceAuthRequestRow>(
        `UPDATE device_auth_requests
         SET status = 'denied'
         WHERE user_code = $1 AND status = 'pending' AND expires_at >= $2
         RETURNING *`,
        [userCode, now],
      );
      return rows[0] ? rowToDeviceAuthRequest(rows[0]) : undefined;
    },
    async consumeToken(deviceCodeHash) {
      await pg.query(
        `UPDATE device_auth_requests SET pending_token = NULL WHERE device_code_hash = $1`,
        [deviceCodeHash],
      );
    },
  };
}

function createPostgresDeviceTokenStore(pg: PgLike): DeviceTokenStore {
  return {
    async create(input) {
      await pg.query(
        `INSERT INTO device_tokens (token_hash, account_id, label, created_at)
         VALUES ($1, $2, $3, $4)`,
        [input.tokenHash, input.accountId, input.label ?? null, input.createdAt],
      );
      return { ...input };
    },
    async resolveByHash(tokenHash) {
      const { rows } = await pg.query<{ account_id: string }>(
        `UPDATE device_tokens SET last_used_at = $2 WHERE token_hash = $1 RETURNING account_id`,
        [tokenHash, Date.now()],
      );
      return rows[0]?.account_id;
    },
  };
}
