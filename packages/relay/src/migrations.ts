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
  /**
   * Issue #657: whether `down` — or, equivalently, leaving this migration's
   * schema change in place while code that predates it runs against the
   * result — is safe. `true` means a pure additive change: nothing built
   * before this migration ever depended on the table/column it adds
   * either way, so `down` cleanly removes it and older code is unaffected
   * whether `down` runs or not. `false` means `down` (or skipping it and
   * just running old code against the new schema) can destroy or orphan
   * data with no way back — see the migration's own comment for why.
   *
   * This is read by `assessRollback` (`migrate.ts`) and, through it,
   * `migrate-cli.ts`'s `assess-rollback` subcommand, which
   * `scripts/deploy-prod.sh`'s `rollback()` actually calls before flipping
   * the relay image back — data the deploy path can act on, not a comment
   * it can't read. An irreversible migration is not forbidden by this
   * flag; it only means a rollback that would cross it gets refused
   * instead of silently proceeding into a schema neither side agreed to.
   */
  reversible: boolean;
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
    reversible: true,
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
    reversible: true,
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
    reversible: true,
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
    reversible: true,
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
    reversible: true,
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
    reversible: true,
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
    reversible: true,
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
    reversible: true,
  },
  {
    // #387: device-authorization grant (RFC 8628-shaped, SPEC §16). One row
    // per pending/resolved request in `device_auth_requests` (never a raw
    // `device_code`, only its hash), and one row per minted device token in
    // `device_tokens` (never a raw token, only its hash) — a resident node's
    // bearer once it's completed the flow, an account-scoped alternative to
    // a Better Auth session token. `pending_token` is the one intentionally
    // *raw* value in this schema: the relay-minted device token, held only
    // between approval and the node's next poll revealing it once
    // (`store.ts`'s `DeviceAuthRequestRecord` doc comment explains why).
    id: '0009_device_auth',
    up: `
      CREATE TABLE device_auth_requests (
        device_code_hash TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        account_id TEXT,
        pending_token TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );

      CREATE TABLE device_tokens (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        label TEXT,
        created_at BIGINT NOT NULL,
        last_used_at BIGINT
      );
      CREATE INDEX device_tokens_account_id_idx ON device_tokens (account_id);
    `,
    down: `
      DROP TABLE IF EXISTS device_tokens;
      DROP TABLE IF EXISTS device_auth_requests;
    `,
    reversible: true,
  },
  {
    // #398: zero-touch authenticated node-token mint. `device_tokens` was
    // keyed only by `token_hash` (#387) with no stable id to list/revoke a
    // token by without exposing its hash — adds `id`, backfilling existing
    // rows from their own `token_hash` (already a one-way SHA-256 digest, so
    // reusing it as a one-time backfill value leaks nothing new) so a token
    // minted before this migration still gets a usable, unique id.
    id: '0010_device_token_ids',
    up: `
      ALTER TABLE device_tokens ADD COLUMN id TEXT;
      UPDATE device_tokens SET id = token_hash WHERE id IS NULL;
      ALTER TABLE device_tokens ALTER COLUMN id SET NOT NULL;
      CREATE UNIQUE INDEX device_tokens_id_idx ON device_tokens (id);
    `,
    down: `
      DROP INDEX IF EXISTS device_tokens_id_idx;
      ALTER TABLE device_tokens DROP COLUMN IF EXISTS id;
    `,
    // Irreversible (issue #657): `down` drops `id` outright, and unlike
    // the one-time backfill above (`id = token_hash`, deterministic and
    // therefore replayable), every token minted AFTER this migration gets
    // its own real `id` from the caller (`store-postgres.ts`'s
    // `insert(input)` — see its own comment), independent of `token_hash`
    // and not derivable from it. Rolling this back after such a token
    // exists permanently loses the only handle `revoke(id, accountId)`
    // has on it, and the pre-migration insert statement a rolled-back
    // relay would run has no `id` column to satisfy `id SET NOT NULL`
    // with in the first place — it fails outright, not silently.
    reversible: false,
  },
  {
    // SPEC §7.26, issue #221: the connected-account metadata row — no
    // secret ever lands in this table (`secret_ref` names a node-local OS
    // keyring entry, never a token), same "account-scoped, plaintext,
    // no-secret" exception already established for `devices`/`sessions`/
    // `device_tokens` above. `scopes`/`capabilities` are JSON-encoded TEXT
    // (see `store-postgres.ts`'s `createPostgresConnectedAccountStore` doc
    // comment for why not a JSONB/child-table). Composite primary key,
    // exactly like `leases`/`push_subscriptions`: `id` (the derived
    // `provider:host:providerAccountId`) is only unique per owning
    // `account_id`, not globally.
    id: '0011_connected_accounts',
    up: `
      CREATE TABLE connected_accounts (
        account_id TEXT NOT NULL,
        id TEXT NOT NULL,
        provider TEXT NOT NULL,
        host TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        label TEXT NOT NULL,
        avatar_url TEXT,
        credential_source TEXT NOT NULL,
        scopes TEXT,
        capabilities TEXT NOT NULL,
        connected_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        secret_ref TEXT NOT NULL,
        PRIMARY KEY (account_id, id)
      );
    `,
    down: `DROP TABLE IF EXISTS connected_accounts;`,
    reversible: true,
  },
  {
    // Zed-parity F3-3, issue #760: the user-editable keymap, one opaque
    // envelope per account — same single-row-per-account shape as
    // `amk_escrow` (`0006_amk_escrow`), reusing the envelope column
    // convention `amk_rotation_pending` (`0007_amk_rotation`) already
    // established (`envelope_resource_id`/`envelope_iv`/
    // `envelope_ciphertext`/`envelope_alg`) rather than inventing a new
    // one. No node, no session, no project column at all: a keymap is a
    // pure account/UI concern the relay stores blind ciphertext for,
    // exactly like every other content family.
    id: '0012_keymaps',
    up: `
      CREATE TABLE keymaps (
        account_id TEXT PRIMARY KEY,
        envelope_resource_id TEXT NOT NULL,
        envelope_iv TEXT NOT NULL,
        envelope_ciphertext TEXT NOT NULL,
        envelope_alg TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `,
    down: `DROP TABLE IF EXISTS keymaps;`,
    reversible: true,
  },
  {
    // Device-switch state preservation (issue #198, epic #6): one opaque
    // view-state envelope per SESSION (not account, unlike `keymaps` above)
    // — the composer draft, open canvas tab, and last-viewed transcript
    // item a device had, so switching devices mid-session resumes at a
    // sensible point instead of a cold reload to the top. Same envelope
    // column convention as `keymaps`/`amk_rotation_pending`, plus
    // `revision`, the writing device's own `session_update.seq` high-water
    // mark at write time (`@loombox/protocol`'s `session-view-state.ts` own
    // doc comment covers what it's for). No `ON DELETE CASCADE` FK to
    // `sessions`: `SessionStore.deleteSession` never actually deletes that
    // table's own row (see its own doc comment), so `relay.ts`/`prune.ts`
    // delete this table's row explicitly wherever they call
    // `deleteSession`.
    id: '0013_session_view_state',
    up: `
      CREATE TABLE session_view_state (
        session_id TEXT PRIMARY KEY,
        envelope_resource_id TEXT NOT NULL,
        envelope_iv TEXT NOT NULL,
        envelope_ciphertext TEXT NOT NULL,
        envelope_alg TEXT NOT NULL,
        revision BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `,
    down: `DROP TABLE IF EXISTS session_view_state;`,
    reversible: true,
  },
];
