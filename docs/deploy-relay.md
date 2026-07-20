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
- `redis` (opt-in, `--profile redis`) — the fan-out backend (#97) for running
  more than one relay replica. A single relay instance (the default) doesn't
  need this: it uses in-process fan-out. See "Redis fan-out" below.

## Prerequisites

- prodbox with Docker + Caddy (already provisioned).
- DNS `A relay.loombox.dev -> <prodbox public IP>`, DNS-only (grey cloud) so
  Caddy manages TLS.
- A GitHub OAuth App (required) and, optionally, a Google OAuth client — see
  "OAuth provider setup" below.

## OAuth provider setup (#120)

loombox login is Google/GitHub OAuth only (SPEC §8), and it's a self-hoster's
own OAuth App/Client: no loombox-run broker sits in the middle, so register
these against your own GitHub/Google account. Both providers request
identity-only scopes (`read:user`/`user:email`-class, each provider's own
default) — never the broader scopes a connected GitHub/Jira account (SPEC
§7.26) uses. GitHub is required; Google is optional and purely additive —
leaving `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` unset just means the Google
button doesn't appear, nothing else changes (see the startup log line below).

### GitHub OAuth App (required)

1. github.com > Settings > Developer settings > OAuth Apps > New OAuth App.
2. Homepage URL: `https://relay.loombox.dev`.
3. Authorization callback URL, exactly: `https://relay.loombox.dev/api/auth/callback/github`.
4. Generate a client secret, then set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in `.env`.

### Google OAuth client (optional)

1. In a Google Cloud project, console.cloud.google.com > APIs & Services >
   OAuth consent screen — configure it (External is fine for a personal
   deployment; internal scopes only, no verification needed for `email`/`profile`).
2. APIs & Services > Credentials > Create Credentials > OAuth client ID, type
   **Web application**.
3. Authorized redirect URI, exactly: `https://relay.loombox.dev/api/auth/callback/google`.
4. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`.

### Verifying providers are active

On boot, the relay logs exactly which providers took effect — check this
after any OAuth env change instead of waiting for a user to hit a dead login
button:

```
loombox relay: OAuth login providers active: github, google
```

(or `github` alone, or `OAuth login: no providers configured (...)` if both
are missing — that isn't a crash, but nobody can log in until one is set).

### Login failures

A denied consent screen or a provider-side error lands back on Better Auth's
own `/api/auth/callback/:provider` error handling (it redirects with an
error query param rather than hanging) — the PWA's login screen is
responsible for surfacing that, not the relay silently swallowing it.

## Configure

Copy `deploy/relay/.env.example` to `deploy/relay/.env` on the host (chmod 600)
and fill in:

- `POSTGRES_PASSWORD` — `openssl rand -base64 32`
- `BETTER_AUTH_SECRET` — `openssl rand -base64 48`
- `RELAY_PUBLIC_URL` — `https://relay.loombox.dev`
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — from the OAuth App above
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — optional, from the Google OAuth client above
- `REDIS_URL` — optional (#97), only for a multi-replica deployment; see "Redis fan-out" below

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

## Redis fan-out (#97, multi-instance only)

A single relay instance (the default deploy above) never needs this: it
fans session updates and session-scoped control messages (permission
requests, blob refs) out to subscribed clients in-process, exactly as
before. Redis only matters once you run more than one relay replica behind a
load balancer, so a client connected to instance B can receive an update
whose owning node is connected to instance A.

**Design**: channel-per-session. Each relay process subscribes to a
session's Redis channel (`loombox:relay:session:<sessionId>`) only while it
has at least one local client resumed on that session, and unsubscribes once
the last one disconnects — a relay never holds subscriptions for sessions
nobody local cares about. Every payload published is the exact same opaque
wire message (`session_update`, `resync_marker`, or a session-scoped direct
message) the relay already forwards over `/ws`; Redis carries ciphertext
fields exactly as-is, the relay never decrypts to route.

To enable it:

```bash
cd /opt/apps/loombox/deploy/relay
# set REDIS_URL=redis://redis:6379 in .env first
docker compose --profile redis up -d --build
```

Run multiple `relay` container instances (e.g. via `docker compose up -d
--scale relay=2 --profile redis`, or separate hosts each with `REDIS_URL`
pointed at the same Redis) behind whatever load balances WebSocket
connections across them (Caddy can round-robin to multiple upstreams). Every
instance must share both the same Postgres (`DATABASE_URL`) and the same
Redis (`REDIS_URL`) — Postgres is the routing/session-metadata source of
truth, Redis is only the live fan-out plane.

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
