# Deploying the loombox relay (prodbox)

The relay is the only server component. It is a blind router (SPEC §315): it
stores routing metadata and opaque ciphertext only, never plaintext. This is the
runbook for the self-hostable Docker deployment (#105), as run on prodbox behind
Caddy at `https://relay.loombox.dev`.

## What it runs

- `postgres:16-alpine` — the ciphertext + routing-metadata store (named volume
  `loombox-pg-data`).
- `relay` — Fastify + WebSocket + Better Auth, built from
  `packages/relay/Dockerfile`, published on `127.0.0.1:5185` and fronted by
  Caddy. It self-migrates on boot (`runMigrations up`) and mounts Better Auth
  when `DATABASE_URL` is set.

Redis fan-out (#97) is not part of this compose: a single relay instance uses
in-process fan-out. Add Redis only when running more than one relay replica.

## Prerequisites

- prodbox with Docker + Caddy (already provisioned).
- DNS `A relay.loombox.dev -> <prodbox public IP>`, DNS-only (grey cloud) so
  Caddy manages TLS.
- A GitHub OAuth App with callback `https://relay.loombox.dev/api/auth/callback/github`.

## Configure

Copy `deploy/relay/.env.example` to `deploy/relay/.env` on the host (chmod 600)
and fill in:

- `POSTGRES_PASSWORD` — `openssl rand -base64 32`
- `BETTER_AUTH_SECRET` — `openssl rand -base64 48`
- `RELAY_PUBLIC_URL` — `https://relay.loombox.dev`
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — from the OAuth App
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — optional

## Bring up

```bash
cd /opt/apps/loombox/deploy/relay
docker compose up -d --build
# health (through the loopback publish, before Caddy):
curl -fsS http://127.0.0.1:5185/health   # -> {"status":"ok"}
```

Add the Caddy site block (`deploy/relay/Caddyfile.snippet`) to
`/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`. Caddy provisions the
TLS cert on first request; verify:

```bash
curl -fsS https://relay.loombox.dev/health   # -> {"status":"ok"}
```

## Updating

Re-sync the repo to `/opt/apps/loombox`, then:

```bash
cd /opt/apps/loombox/deploy/relay
docker compose up -d --build
```

Migrations run automatically on the relay's boot. To roll a migration back
manually, `docker compose exec relay pnpm --filter @loombox/relay migrate down`.

## Backup & disaster recovery

The relay's Postgres database is the only copy of everything it holds - set up
the nightly encrypted backup and read the restore runbook before this goes
live with real users. See `docs/relay-backup.md`.
