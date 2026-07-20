# Relay backup & disaster recovery (#103)

The relay's Postgres database is the sole copy of the device registry, session
index/resync ring, blob store, and (once `DATABASE_URL` is set) Better Auth's
own `user`/`session`/`account`/`verification` tables (`auth.ts`) - and will be
the sole copy of the wrapped-AMK recovery-code escrow blob table once that
ships (SPEC §8/§9; not yet built as of this writing). None of it has a second
copy anywhere else. This is the nightly encrypted-backup + tested-restore line
SPEC §9 calls for.

See also `docs/deploy-relay.md` for the base deployment this backs up.

## How it works

- **`pnpm --filter @loombox/relay backup`** (`packages/relay/src/backup-cli.ts`)
  runs `pg_dump --format=custom` against the *whole* configured database (not
  a hand-picked table list - see that file's doc comment for why: any table
  that exists now or is added later, including a future escrow table, is
  covered automatically), encrypts the dump with AES-256-GCM using an
  operator-supplied key (`RELAY_BACKUP_ENCRYPTION_KEY`), and writes a
  timestamped `relay-backup-<ISO timestamp>.dump.enc` file to
  `RELAY_BACKUP_DIR` (default `./backups`). It then prunes older backups down
  to `RELAY_BACKUP_RETENTION_COUNT` (default 14).
- **`pnpm --filter @loombox/relay restore <file>`**
  (`packages/relay/src/restore-cli.ts`) decrypts a `.dump.enc` file and runs
  `pg_restore --clean --if-exists` against the `DATABASE_URL` you point it at.
  It never guesses a target - always the currently configured `DATABASE_URL`,
  so pointing it at production is an explicit, visible choice.
- **Encryption**: `node:crypto` AES-256-GCM (an AEAD - tampering or corruption
  fails decryption loudly rather than restoring garbage), not `age`/`gpg`. The
  relay already shells out to `pg_dump`/`pg_restore`; adding a second external
  binary for what `node:crypto` already does correctly (and which this repo
  already depends on via `pg`/`better-auth`'s own crypto use) would be extra
  dependency and process-spawn surface for no real capability gain. See
  `packages/relay/src/backup-crypto.ts`'s doc comment for the full reasoning.
  The key is a raw 256-bit key, base64-encoded - the same convention this repo
  already uses for `POSTGRES_PASSWORD`/`BETTER_AUTH_SECRET`
  (`openssl rand -base64 32`), not a passphrase (no KDF involved, no
  passphrase-strength question to get wrong).

## Prerequisites

- The relay's Docker image (`packages/relay/Dockerfile`) bundles a
  version-matched `postgresql-client-16` (PGDG apt repo) alongside its own
  `pg_dump`/`pg_restore` - Postgres's own compatibility rule is that a
  *newer* client can dump an *older* server, never the reverse, and the
  compose stack's `postgres:16-alpine` needs an exact-major client. Both CLIs
  run **inside the `relay` container** (`docker compose exec relay ...`),
  which already has `DATABASE_URL` pointed at the `postgres` service and
  network access to it - no separate client install needed on the host.
- `deploy/relay/docker-compose.yml` bind-mounts `./backups` (host) to
  `/app/backups` (container) on the `relay` service, so encrypted artifacts
  land on the host filesystem where an off-box shipping step (below) can
  reach them, and survive `relay` container recreation.

## Nightly scheduling (prodbox)

`deploy/relay/relay-backup.sh` wraps the `docker compose exec` invocation,
loading `.env` for `RELAY_BACKUP_ENCRYPTION_KEY`/`RELAY_BACKUP_RETENTION_COUNT`.
Run it manually to confirm it works, then install the systemd timer:

```bash
cd /opt/apps/loombox/deploy/relay
./relay-backup.sh   # manual smoke test - should print "backup: wrote relay-backup-....dump.enc"

sudo cp systemd/relay-backup.service.example /etc/systemd/system/relay-backup.service
sudo cp systemd/relay-backup.timer.example /etc/systemd/system/relay-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now relay-backup.timer
systemctl list-timers relay-backup.timer   # confirm next run time
```

The timer runs nightly at 03:00 host time (±15min jitter); `Persistent=true`
catches up on the next boot if the host was off at 03:00. A cron alternative
(`crontab -e` as the `prod` user) if you'd rather not use a systemd timer:

```cron
0 3 * * * /opt/apps/loombox/deploy/relay/relay-backup.sh >> /var/log/relay-backup.log 2>&1
```

### Alerting on failure

`backup-cli.ts` exits non-zero and prints the error on any failure (missing
env, `pg_dump` non-zero exit, a bad encryption key) - never a silent partial
success. Two independent ways to notice, use both:

- **On-failure (systemd)**: `systemd/relay-backup.service.example`'s
  `OnFailure=` fires whenever the service unit fails. Point it at whatever
  this host already has (Debian's `systemd-mailer` package ships
  `status-email-admin@.service`; a one-line unit that `curl`s a webhook works
  too). `journalctl -u relay-backup.service` always has the full output
  regardless.
- **Dead-man's-switch ("did it even run")**: catches the timer itself failing
  to fire, which `OnFailure=` can't see. Add an `ExecStartPost=` line to the
  service pinging a free monitor (e.g. healthchecks.io): `ExecStartPost=/usr/bin/curl -fsS -m 10 --retry 3 https://hc-ping.com/<uuid>`.

## Off-box shipping

`relay-backup.sh` has a commented `rclone copy ./backups <remote>:...` line at
the end - configure an `rclone` remote (`rclone config`) pointing at
whatever off-box storage you use (S3-compatible, a second host over SFTP,
etc.), then uncomment it. `restic` is an equally reasonable choice if you
want deduplication/snapshots instead of plain file copies; either way, the
artifact being shipped is already encrypted, so the remote itself doesn't
need to be trusted with anything beyond availability.

## Restore drill

**This has been run once against a scratch database as part of building this
feature** (`docker compose exec relay pnpm --filter @loombox/relay backup`
against a live compose stack with a seeded row, then `restore` into a fresh
`loombox_restore_drill` database in the same Postgres instance, then a direct
`SELECT` confirming the row round-tripped byte-for-byte). Re-run this drill
periodically (e.g. quarterly, or after any schema migration) - a backup you
have never restored is not a backup you can trust.

```bash
cd /opt/apps/loombox/deploy/relay

# 1. Create a scratch database in the same Postgres instance (never restore
#    directly into the live `loombox` database on a drill).
docker compose exec postgres psql -U loombox -d loombox -c "CREATE DATABASE loombox_restore_drill;"

# 2. Pick the backup to restore (or copy one back down from off-box storage).
ls backups/

# 3. Restore it into the scratch database.
docker compose exec -T \
  -e RELAY_BACKUP_ENCRYPTION_KEY="$(grep RELAY_BACKUP_ENCRYPTION_KEY .env | cut -d= -f2-)" \
  -e DATABASE_URL="postgresql://loombox:${POSTGRES_PASSWORD}@postgres:5432/loombox_restore_drill" \
  relay pnpm --filter @loombox/relay restore /app/backups/<file>.dump.enc

# 4. Verify - row counts, or a specific known row.
docker compose exec postgres psql -U loombox -d loombox_restore_drill -c "SELECT count(*) FROM devices;"

# 5. Clean up the scratch database.
docker compose exec postgres psql -U loombox -d loombox -c "DROP DATABASE loombox_restore_drill;"
```

### Full-outage recovery (restoring `loombox` itself)

Only after a drill has confirmed the backup is good:

```bash
cd /opt/apps/loombox/deploy/relay
docker compose stop relay   # stop writers before restoring over the live database
docker compose exec -T \
  -e RELAY_BACKUP_ENCRYPTION_KEY="$(grep RELAY_BACKUP_ENCRYPTION_KEY .env | cut -d= -f2-)" \
  relay pnpm --filter @loombox/relay restore /app/backups/<file>.dump.enc
docker compose start relay
curl -fsS https://relay.loombox.dev/health
```

`restore-cli.ts` runs `pg_restore --clean --if-exists`, which drops and
recreates objects from the dump - it is a full overwrite of the target
database's contents, not a merge.

## Testing

- `packages/relay/src/backup-crypto.test.ts` - the AES-256-GCM encrypt/decrypt
  round trip, wrong-key and tampered-ciphertext rejection, bad-magic/truncated-
  file handling. Hermetic, no Docker.
- `packages/relay/src/backup.test.ts` - `pg_dump`/`pg_restore` command
  construction (including the docker-wrapped-command override) against a
  fake `child_process.spawn`, plus retention-count selection. Hermetic, no
  Docker.
- `packages/relay/src/backup-restore.integration.test.ts` - the real
  dump -> encrypt -> decrypt -> restore round trip against a live Postgres,
  asserting a seeded row survives byte-for-byte. **Skipped by default**
  (gated behind `LOOMBOX_TEST_PG_URL`, the same convention
  `store-postgres.test.ts` already uses) since it needs a running Postgres
  and two real `pg_dump`/`pg_restore` process spawns. Run it:

  ```bash
  docker run --rm -d -p 15599:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
  LOOMBOX_TEST_PG_URL=postgresql://postgres:postgres@127.0.0.1:15599/postgres \
    pnpm --filter @loombox/relay exec vitest run src/backup-restore.integration.test.ts
  ```

  It invokes `pg_dump`/`pg_restore` via a `docker run --network host
  postgres:16-alpine` wrapper rather than assuming a matching client binary
  is on the test runner's own `PATH` (see the test file's doc comment).
