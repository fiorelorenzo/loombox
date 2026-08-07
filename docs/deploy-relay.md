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

### Verifying isolation once it's live (#868, epic #863)

The isolation claim is the entire reason the preview environment exists.
Re-run this whole section after any change to either environment's compose
file, `.env`, or Postgres — not just once at setup. What's cheap to
automate is an automated test (`packages/relay/src/auth.test.ts`'s
`preview/production isolation (#868, epic #863)` describe block, run with
every `pnpm --filter @loombox/relay test`); the rest is the commands below,
run by hand, with the output they should produce.

#### 1. Databases: an account on one does not exist on the other

Query both directly - never infer from the UI:

```bash
# preview
cd /opt/apps/loombox-preview/deploy/relay-preview
docker compose exec -T postgres psql -U loombox_preview -d loombox_preview -c 'select id, email from "user";'

# production
cd /opt/apps/loombox/deploy/relay
docker compose exec -T postgres psql -U loombox -d loombox -c 'select id, email from "user";'
```

Expected (checked 2026-08-07, before preview had ever been signed into):
production returns exactly the one real account
(`fiorelorenzo.fl@gmail.com`); preview returns zero rows. After a GitHub
sign-in on `https://preview.loombox.dev`, preview's query shows the new row
and production's is unchanged - the two `select`s never overlap because
they are two different `psql` connections to two different Postgres
containers (see "4. Containers and volumes" below), not two views of one
database.

#### 2. Auth: a bearer token minted by one is rejected by the other

The mechanism (`better-auth`'s `bearer` plugin): a session's bearer token is
`<sessionToken>.<HMAC-SHA256(secret, sessionToken)>`. The receiving side
recomputes the HMAC with **its own** `secret` and rejects the request
outright, before ever touching the database, if it doesn't match -
`packages/relay/src/auth.test.ts`'s `preview/production isolation` tests
exercise exactly this with two `createRelayAuth` instances built from two
different secrets (the automated half of this check, runs in CI). This is
why `BETTER_AUTH_SECRET` must differ between the two `.env` files
(`deploy/relay/.env`, `deploy/relay-preview/.env`) and never be copied from
one to the other - confirm they're actually different without ever
printing either one:

```bash
A=$(grep '^BETTER_AUTH_SECRET=' /opt/apps/loombox/deploy/relay/.env | sha256sum)
B=$(grep '^BETTER_AUTH_SECRET=' /opt/apps/loombox-preview/deploy/relay-preview/.env | sha256sum)
[ "$A" = "$B" ] && echo MATCH-BAD || echo DIFFERENT-GOOD
```

Expected: `DIFFERENT-GOOD`.

To see the rejection itself against the live relays rather than trust the
mechanism, mint a real token from a real (throwaway) account on one side
and present it to the other's `GET /account` (an authenticated, read-only
endpoint that echoes back the resolved `accountId` or 401s - see
`relay.ts`). There is no non-interactive sign-in on either deploy (GitHub
OAuth only, by design - see "OAuth provider setup" above), so minting a
token means running a throwaway `enableEmailPasswordForTests: true`
`createRelayAuth` instance *pointed at the live database, using the
container's own already-configured `DATABASE_URL`/`BETTER_AUTH_SECRET`*
(never printed) - the same escape hatch `auth.test.ts` uses, the same
signing code path a real GitHub sign-in goes through, just skipping the
consent screen:

```bash
# run once, inside whichever relay container should mint the token -
# writes nothing outside that one throwaway user/session/account row
cat > /tmp/mint.ts <<'EOF'
import { Pool } from 'pg';
import { createRelayAuth } from './auth';
const email = `isolation-check+${Date.now()}@loombox.dev`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const auth = createRelayAuth({
  database: pool,
  baseURL: process.env.RELAY_PUBLIC_URL ?? 'http://localhost:8787',
  secret: process.env.BETTER_AUTH_SECRET!,
  enableEmailPasswordForTests: true,
});
const resp = await auth.api.signUpEmail({
  body: { email, password: `x-${Math.random()}`, name: 'isolation-check' },
  asResponse: true,
});
console.log(JSON.stringify({ email, token: resp.headers.get('set-auth-token') }));
await pool.end();
EOF
docker cp /tmp/mint.ts "$(docker compose ps -q relay)":/app/packages/relay/src/mint.ts
docker compose exec -T relay sh -c 'cd /app && pnpm --filter @loombox/relay exec tsx src/mint.ts'
docker compose exec -T relay rm -f /app/packages/relay/src/mint.ts

# then, with $TOKEN set to the printed token:
curl -sS -o /dev/null -w '%{http_code}\n' https://preview-relay.loombox.dev/account -H "Authorization: Bearer $TOKEN"
curl -sS -o /dev/null -w '%{http_code}\n' https://relay.loombox.dev/account -H "Authorization: Bearer $TOKEN"
```

Expected, run 2026-08-07 with a token minted inside the **preview**
container: `200` (with `{"accountId":"..."}`) against
`preview-relay.loombox.dev`, `401` (`{"error":"invalid or missing auth
token"}`) against `relay.loombox.dev` - the deliberate cross attempt,
refused. Repeated with a token minted inside the **production** container:
`200` against `relay.loombox.dev`, `401` against
`preview-relay.loombox.dev` - the reverse holds too. Clean up the throwaway
row afterward on whichever side minted it:
`delete from session where "userId" in (select id from "user" where email
like 'isolation-check+%'); delete from account where "userId" in (...);
delete from "user" where email like 'isolation-check+%';` (same three
statements, `psql -U loombox -d loombox` or `-U loombox_preview -d
loombox_preview` as appropriate) - re-run "1. Databases" above afterward to
confirm the row count is back to what it was before.

#### 3. Node identities and sessions: a node paired with one never appears in the other's account

A paired node is a row in `devices` (SPEC's node identity, keyed by
`device_id` with an `account_id` column) and its sessions are rows in
`sessions` - both tables live in the same Postgres container as `user`
above, so "1. Databases" already covers this by construction (there is no
cross-container query to run - preview's relay process holds no connection
string to production's Postgres, or vice versa; see `DATABASE_URL` in each
`docker-compose.yml`). Confirmed directly:

```bash
docker compose exec -T postgres psql -U loombox -d loombox \
  -c 'select count(*) from devices; select count(*) from sessions;'
docker compose exec -T postgres psql -U loombox_preview -d loombox_preview \
  -c 'select count(*) from devices; select count(*) from sessions;'
```

Checked 2026-08-07: production had 5 devices / 1 session (real, paired
nodes); preview had 0 of each (never paired against). Every `devices`/
`sessions` row the relay ever writes carries the `account_id` of the
connection that created it (`relay.ts`'s `handleNodeMessage`), and that
`account_id` only ever resolves via *that relay's own* Better Auth/device-
token store - there is no code path from a preview-resolved `account_id`
into a query against production's `devices` table, because there is no
code path from preview into production's database at all.

#### 4. Relay routing: a message addressed to a session id from the other environment routes nowhere

Already covered by the existing test suite, not new to #868: every
session-scoped and node-scoped message handler in `relay.ts` checks
`record.meta.accountId !== connection.accountId` (or the node/device
equivalent) before routing, and `relay.test.ts` has a dedicated "ignores a
... for an unknown session instead of throwing" test per message type plus
several "a different account ... must never see it" tests exercising the
account-mismatch branch directly (`grep -n 'for unknown/foreign\|ignores a\|different account' packages/relay/src/relay.test.ts`).
Preview and production narrow this further to a structural guarantee
rather than a runtime check: a session id minted on preview is a row in
preview's `sessions` table only (see "3." above), so `store.sessions.get`
on production's store returns nothing for it regardless of any
`accountId` - the per-account check is defense in depth for two accounts
colliding on the same relay, not what's carrying the preview/production
split.

#### 5. Containers and volumes: neither compose project can stop, rebuild, or wipe the other's

This is read-only - list names, never demonstrate a wipe:

```bash
docker compose ls -a               # project name + compose file path per project
docker volume ls | grep loombox    # named volume per project
docker network ls | grep loombox   # compose-internal network per project
```

Expected, checked 2026-08-07:

| | production | preview |
| --- | --- | --- |
| compose project name | `relay` (from `deploy/relay/docker-compose.yml`'s directory - no explicit `name:`) / `web` | `loombox-relay-preview` (explicit `name:` in `deploy/relay-preview/docker-compose.yml`) / `loombox-web-preview` |
| Postgres volume | `relay_loombox-pg-data` | `loombox-relay-preview_loombox-preview-pg-data` |
| compose network | `relay_default` | `loombox-relay-preview_default` |
| containers | `relay-relay-1`, `relay-postgres-1`, `web-web-1` | `loombox-relay-preview-relay-1`, `loombox-relay-preview-postgres-1`, `loombox-web-preview-web-1` |
| directory | `/opt/apps/loombox` | `/opt/apps/loombox-preview` |

Every name in the preview column differs from its production counterpart,
so `docker compose down`, `up --build`, or `down -v` run from
`/opt/apps/loombox-preview/deploy/relay-preview` (or `web-preview`)
addresses only the `loombox-*-preview` project - Compose resolves a
project by name (from `name:` in the file, or the containing directory when
absent) and only ever touches containers/volumes/networks labeled with
that project name. There is structurally no shared name for a command run
from the preview directory to accidentally match production's. Confirm
production's own containers never moved before/after touching preview:
`docker ps -q | sort | md5sum` (or diff the id list) run on prodbox before
and after any preview deploy - the production `relay-relay-1` /
`relay-postgres-1` / `web-web-1` container IDs must be byte-identical,
since preview never runs a command inside `/opt/apps/loombox`.
