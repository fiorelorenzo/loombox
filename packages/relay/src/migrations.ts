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
];
