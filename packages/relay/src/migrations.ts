/**
 * Relay core-table migrations (#96). Hand-rolled rather than node-pg-migrate/
 * drizzle to keep the dependency surface small — each migration is a plain
 * `up`/`down` SQL pair, applied in order and tracked in `_migrations` so a
 * re-run is a no-op (idempotent, safe for CI and the Docker entrypoint).
 *
 * Tables here back `DeviceStore`, `SessionStore`, and `BlobStore`
 * (`store.ts`'s interfaces) — never plaintext session/resource content, only
 * routing metadata and opaque `EncryptedEnvelope` columns (SPEC §8's
 * metadata boundary). `TargetStore` has no table: targets are live routing
 * state re-announced by a node on every reconnect, so persisting them across
 * a relay restart has no value and is deliberately kept in-memory only, even
 * in the Postgres-backed `RelayStore`.
 */

export interface Migration {
  id: string;
  up: string;
  down: string;
}

export const migrations: readonly Migration[] = [
  {
    id: '0001_devices',
    up: `
      CREATE TABLE devices (
        device_id TEXT PRIMARY KEY,
        device_public_key TEXT NOT NULL,
        label TEXT,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        registered_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL
      );
      CREATE INDEX devices_account_id_idx ON devices (account_id);
    `,
    down: `DROP TABLE IF EXISTS devices;`,
  },
  {
    id: '0002_sessions',
    up: `
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        envelope_resource_id TEXT NOT NULL,
        envelope_iv TEXT NOT NULL,
        envelope_ciphertext TEXT NOT NULL,
        envelope_alg TEXT NOT NULL
      );
      CREATE INDEX sessions_account_id_idx ON sessions (account_id);

      CREATE TABLE session_seq_counters (
        session_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL
      );

      CREATE TABLE session_rings (
        session_id TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL,
        last_evicted_seq INTEGER
      );

      CREATE TABLE session_ring_entries (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        envelope_resource_id TEXT NOT NULL,
        envelope_iv TEXT NOT NULL,
        envelope_ciphertext TEXT NOT NULL,
        envelope_alg TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `,
    down: `
      DROP TABLE IF EXISTS session_ring_entries;
      DROP TABLE IF EXISTS session_rings;
      DROP TABLE IF EXISTS session_seq_counters;
      DROP TABLE IF EXISTS sessions;
    `,
  },
  {
    id: '0003_blobs',
    up: `
      CREATE TABLE blobs (
        blob_key TEXT PRIMARY KEY,
        envelope_resource_id TEXT NOT NULL,
        envelope_iv TEXT NOT NULL,
        envelope_ciphertext TEXT NOT NULL,
        envelope_alg TEXT NOT NULL
      );
    `,
    down: `DROP TABLE IF EXISTS blobs;`,
  },
  {
    // #101 (per-account storage quota) + #102 (TTL retention pruning). Both
    // new columns are deliberately nullable, with no backfill of existing
    // rows: this relay is already deployed live with real blobs, so
    // defaulting `account_id` to '' or `created_at` to 0 would either
    // silently misattribute pre-migration usage or make every existing blob
    // instantly "infinitely old" and eligible for deletion the moment the
    // retention CLI (#102) first runs against the migrated database. Instead
    // `store.ts`/`prune.ts` treat a NULL `account_id` as "counts toward no
    // one's quota" and a NULL `created_at` as "unknown age, never
    // TTL-pruned" — every row written from this migration forward always
    // populates both, so the safety gap only ever covers pre-migration data.
    id: '0004_blob_quota_retention',
    up: `
      ALTER TABLE blobs ADD COLUMN account_id TEXT;
      ALTER TABLE blobs ADD COLUMN created_at BIGINT;
      CREATE INDEX blobs_account_id_idx ON blobs (account_id);
      CREATE INDEX blobs_created_at_idx ON blobs (created_at);
    `,
    down: `
      DROP INDEX IF EXISTS blobs_created_at_idx;
      DROP INDEX IF EXISTS blobs_account_id_idx;
      ALTER TABLE blobs DROP COLUMN IF EXISTS created_at;
      ALTER TABLE blobs DROP COLUMN IF EXISTS account_id;
    `,
  },
  {
    // #114/#115: the account's escrowed wrapped-AMK blob (SPEC §8 path 2,
    // "recovery-code escrow"). One row per account — `amk_escrow` upserts,
    // overwriting any previous blob for that account. `wrapped_amk` is
    // exactly the opaque base64 string `@loombox/crypto`'s
    // `packWrappedAmkForWire` produced; this table never stores the AMK or
    // the Recovery Code, only ciphertext.
    id: '0005_amk_escrow',
    up: `
      CREATE TABLE amk_escrow (
        account_id TEXT PRIMARY KEY,
        wrapped_amk TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `,
    down: `DROP TABLE IF EXISTS amk_escrow;`,
  },
  {
    // #161/#163: the relay's own self-owned VAPID keypair (one row, ever —
    // `id` is pinned to 1 so a second INSERT can never create a second
    // "current" keypair) and each device's registered Web Push subscription,
    // one row per `(account_id, device_id)` so a re-subscribe overwrites
    // rather than accumulates.
    id: '0006_push',
    up: `
      CREATE TABLE vapid_keys (
        id INTEGER PRIMARY KEY DEFAULT 1,
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        CONSTRAINT vapid_keys_singleton CHECK (id = 1)
      );

      CREATE TABLE push_subscriptions (
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (account_id, device_id)
      );
      CREATE INDEX push_subscriptions_account_id_idx ON push_subscriptions (account_id);
    `,
    down: `
      DROP TABLE IF EXISTS push_subscriptions;
      DROP TABLE IF EXISTS vapid_keys;
    `,
  },
  {
    // #116: device-revocation AMK epoch rotation. `amk_epochs` is the
    // relay's own per-account epoch counter (one row per account, absent ==
    // epoch 0, "never rotated"), advanced only by exactly one per
    // `device_revoke` (`store.ts`'s `AmkRotationStore.advanceEpoch`).
    // `amk_rotation_pending` is one row per surviving device, overwritten by
    // its next revoke's wrap-fan-out if it hasn't fetched yet — never the
    // AMK itself, only the opaque ECDH-wrapped envelope plus which device
    // wrapped it.
    id: '0007_amk_rotation',
    up: `
      CREATE TABLE amk_epochs (
        account_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL
      );

      CREATE TABLE amk_rotation_pending (
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        from_device_id TEXT NOT NULL,
        envelope_resource_id TEXT NOT NULL,
        envelope_iv TEXT NOT NULL,
        envelope_ciphertext TEXT NOT NULL,
        envelope_alg TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (account_id, device_id)
      );
    `,
    down: `
      DROP TABLE IF EXISTS amk_rotation_pending;
      DROP TABLE IF EXISTS amk_epochs;
    `,
  },
  {
    // #82/#104: session-ownership leases. One row per (account_id,
    // session_id) — `holder_node_id`/`expires_at` are the whole of it, since
    // this is purely routing/coordination metadata (which node currently
    // owns a session, and until when), never session content. A fresh
    // `lease_request` upserts in place (`store-postgres.ts`'s
    // `createPostgresLeaseStore`); a `lease_release` deletes the row.
    id: '0008_leases',
    up: `
      CREATE TABLE leases (
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        holder_node_id TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (account_id, session_id)
      );
      CREATE INDEX leases_expires_at_idx ON leases (expires_at);
    `,
    down: `DROP TABLE IF EXISTS leases;`,
  },
];
