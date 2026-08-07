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

## Monitoring (#270, SPEC §7.21)

`/health` is a readiness probe, not just a liveness one: it round-trips
`SELECT 1` against Postgres and `PING` against Redis (when `REDIS_URL` is
set) before answering, each against its own short timeout so a hung
dependency 503s instead of hanging the request. 200 means both are
reachable (Redis is skipped, not required, when it isn't configured — a
single-instance deploy has no Redis at all); a 503 body names which
dependency failed, e.g. `{"status":"unhealthy","failed":["postgres"]}`.
Unauthenticated and exempt from the per-IP rate limit, since an external
checker carries no session and polls far more often than any real device
reconnects.

**Point an external uptime service at `https://relay.loombox.dev/health`.**
The relay can't alert on its own outage, so alerting can't depend on it —
wire a third-party check (UptimeRobot, Better Uptime, a Caddy/Prometheus
blackbox probe, ...) to page you on a non-200 response instead of waiting
for a user to notice.

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

Re-sync the repo to `/opt/apps/loombox`, then rebuild:

```bash
# from the devbox, on the commit you want live
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.svelte-kit' \
  --exclude 'apps/web/build' \
  --exclude 'deploy/relay/.env' --exclude 'deploy/relay/backups' \
  --exclude 'releases' --exclude 'DEPLOYED.json' \
  ./ prodbox:/opt/apps/loombox/

# on prodbox — the build takes 2-3 minutes, so run it detached rather than
# through a short-lived SSH command that will time out mid-build
cd /opt/apps/loombox/deploy/relay
docker compose up -d --build
```

**None of those excludes is optional**, because none of the paths is in git
(or, for `releases`/`DEPLOYED.json`, is state the tag deploy pipeline owns)
and a `--delete` sync therefore removes it from the host:

- `deploy/relay/.env` holds `BETTER_AUTH_SECRET` (losing it invalidates every
  login session) and `POSTGRES_PASSWORD`.
- `deploy/relay/backups/` holds the encrypted database dumps, the only copy of
  everything the relay stores (see `docs/relay-backup.md`).
- `releases/` and `DEPLOYED.json` are `scripts/deploy-prod.sh`'s own state
  (CONTRIBUTING.md#deploying-to-prod) — `releases/current` is what the live
  web container actually has bind-mounted
  (`deploy/web/docker-compose.live.yml`), so deleting it out from under a
  running deploy is exactly the mistake this exclude list exists to prevent.

`deploy/web/docker-compose.live.yml` used to need excluding here too, for
the same not-in-git reason — it doesn't anymore: it's tracked in git now
(see its own header comment for why). A plain sync picks it up like any
other tracked file.

Migrations run automatically on the relay's boot. To roll a migration back
manually, `docker compose exec relay pnpm --filter @loombox/relay migrate down`.

### A stale relay fails silently

The relay validates every inbound frame against `@loombox/protocol`'s
discriminated union and **drops** anything it does not recognise, logging
`relay: dropped an invalid wire frame`. A relay older than a client therefore
does not report a version mismatch: the client just never gets an answer and
times out. If a feature that shipped with a new message type appears dead in
production, check for that log line before debugging the client:

```bash
docker compose logs relay --since 10m | grep invalid_union_discriminator
```

## Backup & disaster recovery

The relay's Postgres database is the only copy of everything it holds - set up
the nightly encrypted backup and read the restore runbook before this goes
live with real users. See `docs/relay-backup.md`.

## Preview environment (#864, epic #863)

A second, fully isolated relay deployment for testing changes before they
reach production - same shape as everything above, run from
`deploy/relay-preview/` instead of `deploy/relay/`, under its own directory
on prodbox (`/opt/apps/loombox-preview`) rather than inside production's.
Nothing is shared with production: not the Postgres container, not the
named volume, not the port, not `BETTER_AUTH_SECRET`, not the GitHub OAuth
App. See `deploy/relay-preview/docker-compose.yml`'s header comment for the
isolation reasoning behind each of those.

### Prodbox loopback port map

Every app on this box publishes to a loopback port that Caddy fronts.
Picking a preview-relay port meant checking this whole table, not just
production's own two:

| Port | What |
| ---- | ------------------------------------------------------- |
| 5181 | pitchbox prod web |
| 5185 | loombox prod relay |
| 5186 | loombox prod web |
| 5187 | loombox preview relay (#864) |
| 5188 | **loombox preview web (#865, epic #863)** |
| 5190 | loombox-landing web |
| 5191 | pitchbox preview web |
| 5281 | embertold prod web |
| 5291 | embertold preview web |
| 5434 | pitchbox prod postgres |

(Confirmed free via `ss -tlnp` on prodbox at the time #864 was written, and
rechecked the same way — plus this table's own last-known state — when
#865 claimed 5188 for preview web.) loombox preview's Postgres publishes
no host port at all, same as production's - only the `relay` and preview
web's own `web` service need one, each reached over its own
compose-internal network.

### Bring up

```bash
cd /opt/apps/loombox-preview/deploy/relay-preview
docker compose up -d --build
curl -fsS http://127.0.0.1:5187/health   # -> {"status":"ok"}
```

`docker compose up` interpolates the entire compose file before starting
anything, so this refuses to start - cleanly, before creating a single
container, Postgres included - until `.env` defines all four of
`POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET`; see `deploy/relay-preview/.env.example`. Verified
empirically against a scratch compose file with the identical
`${VAR:?message}` pattern: an unset required var anywhere in the file fails
the whole command with `required variable ... is missing a value`, not
just the service that references it.

Add the Caddy site block (`deploy/relay-preview/Caddyfile.snippet`) to
`/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy` (`caddy reload`
validates the new config before applying it and leaves the previous config
running on any error, so a mistake here can't take the other vhosts -
including production's - down with it). Once the DNS record below exists,
Caddy provisions the TLS cert on first request:

```bash
curl -fsS https://preview-relay.loombox.dev/health   # -> {"status":"ok"}
```

### DNS record

Same shape as `relay.loombox.dev`'s own record - DNS-only (grey cloud), so
Caddy rather than Cloudflare terminates TLS:

| Type | Name                       | Content         | Proxied | TTL  |
| ---- | --------------------------- | --------------- | ------- | ---- |
| A    | `preview-relay.loombox.dev` | `152.53.44.195` | false   | auto |

### The one step that can't be scripted: the GitHub OAuth App

Better Auth's OAuth callback is registered per GitHub OAuth App, and
production's App is registered for `relay.loombox.dev` only - reusing it
for preview would mean either the callback fails outright (host mismatch)
or, if it were ever pointed at both, a preview sign-in could mint a
cookie/session shape indistinguishable from production's. GitHub has no API
to create an OAuth App - this is a five-field web form, once:

1. github.com > Settings > Developer settings > OAuth Apps > New OAuth App.
2. Application name: something that says "preview" (e.g. `loombox preview`)
   so it's never confused with production's App in the list.
3. Homepage URL: `https://preview.loombox.dev`.
4. Authorization callback URL, exactly:
   `https://preview-relay.loombox.dev/api/auth/callback/github`.
5. Generate a client secret, then put both values in
   `/opt/apps/loombox-preview/deploy/relay-preview/.env`:
   `GITHUB_CLIENT_ID=...` / `GITHUB_CLIENT_SECRET=...`.

That's the only human-only step in the whole environment: everything else
in this section is scripted or already applied. After it, `docker compose
up -d --build` (above) brings the rest up.

### Verifying isolation once it's live

Confirm a GitHub sign-in on preview creates an account in preview's
database only, not production's:

```bash
# preview - should show the freshly-created account
docker compose -p loombox-relay-preview exec postgres \
  psql -U loombox_preview -d loombox_preview -c 'select id, email from "user";'

# production - should NOT show it
cd /opt/apps/loombox/deploy/relay
docker compose exec postgres psql -U loombox -d loombox -c 'select id, email from "user";'
```

And confirm production's own containers never moved, before and after any
preview deploy: `docker ps -q | sort | md5sum` (or just diff the id list)
run on prodbox before touching preview and again after - the production
`relay-relay-1` / `relay-postgres-1` / `web-web-1` container IDs must be
byte-identical, since preview never runs a command inside
`/opt/apps/loombox`.
