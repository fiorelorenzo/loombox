# Deploying the loombox web PWA (prodbox)

`apps/web` is the SvelteKit PWA client (built with `@sveltejs/adapter-node`),
served as a plain Node process behind Caddy at `https://app.loombox.dev`. It
holds no data of its own and talks to a relay (`packages/relay`) over
WebSocket - see `docs/deploy-relay.md` for the relay side.

## What it runs

- `web` - the built adapter-node server (`apps/web/build/index.js`), built
  from `apps/web/Dockerfile`, published on `127.0.0.1:5186` and fronted by
  Caddy. No database, no secrets beyond `ORIGIN`.

## Relay URL default (#381)

A fresh visitor now lands on a real relay by default: `+page.svelte` reads
`PUBLIC_LOOMBOX_RELAY_URL` via SvelteKit's `$env/dynamic/public` (a plain
runtime env var, not baked into the JS bundle at image-build time) and falls
back to `wss://relay.loombox.dev` when it's unset. `docker-compose.yml`
already sets it to that same default, so there is nothing to configure for
the normal deployment - it's only worth overriding for a non-default one
(e.g. staging against a different relay):

```bash
PUBLIC_LOOMBOX_RELAY_URL=wss://staging-relay.loombox.dev docker compose up -d --build
```

The PWA still has an in-UI "Relay URL" field that persists to the browser's
`localStorage` under `loombox:relay-url`; a self-hoster running their own
relay can point it there per-browser/device, which always overrides this
default once set.

## Prerequisites

- prodbox with Docker + Caddy (already provisioned).
- DNS `A app.loombox.dev -> <prodbox public IP>`, DNS-only (grey cloud) so
  Caddy manages TLS.
- The relay already deployed and reachable at `wss://relay.loombox.dev` (see
  `docs/deploy-relay.md`) - the PWA is not useful without one.

## Bring up

```bash
# from the devbox, rsync the repo to prodbox (source only, matching the relay's
# own deploy - exclude node_modules/.git/.svelte-kit/build/.claude/.emdash):
rsync -av --exclude node_modules --exclude .git --exclude .svelte-kit \
  --exclude build --exclude .claude --exclude .emdash \
  ~/Progetti/loombox/ prod@prodbox:/opt/apps/loombox/

# on prodbox:
cd /opt/apps/loombox/deploy/web
docker compose up -d --build
# health (through the loopback publish, before Caddy):
curl -fsS http://127.0.0.1:5186/
```

The image build takes a minute or two (it installs the workspace and runs
`vite build`) - if running over SSH, background it or use a long timeout
rather than a short one, the same caveat as the relay's own build.

Add the Caddy site block below to `/etc/caddy/Caddyfile`, then
`sudo systemctl reload caddy`. Caddy provisions the TLS cert on first
request; verify:

```bash
curl -fsS https://app.loombox.dev/
```

```caddyfile
app.loombox.dev {
	reverse_proxy 127.0.0.1:5186
}
```

## Configure

No `.env` file is required - `deploy/web/docker-compose.yml` already
defaults both environment variables that matter: `ORIGIN`
(`https://app.loombox.dev`, adapter-node needs the real public origin to
pass its CSRF/form-action check behind a reverse proxy) and
`PUBLIC_LOOMBOX_RELAY_URL` (`wss://relay.loombox.dev`, see above). Override
either only for a non-default deployment:

```bash
ORIGIN=https://staging.loombox.dev PUBLIC_LOOMBOX_RELAY_URL=wss://staging-relay.loombox.dev \
  docker compose up -d --build
```

## Updating

Re-sync the repo to `/opt/apps/loombox`, then:

```bash
cd /opt/apps/loombox/deploy/web
docker compose up -d --build
```

## Preview environment (#865, epic #863)

A second, deployed instance of this same app for trying a change before it
reaches production: `preview.loombox.dev`, its own compose project
(`deploy/web-preview/`), its own loopback port (`5188` - see
`docs/deploy-relay.md`'s port table), pointed at preview's own relay
(`preview-relay.loombox.dev`, #864) rather than production's. Nothing
below is a second, divergent mechanism: the Docker image is the exact same
`apps/web/Dockerfile`, the deploy shape is the exact same `releases/<sha>`
plus `current` symlink (`deploy/web-preview/docker-compose.live.yml`
mirrors this file's own), and the health gate is the exact same
served-build-identity check `scripts/deploy-prod.sh` uses -
`scripts/deploy-preview.sh` is that script with the tag argument and the
relay half removed (preview's relay is a separate, manually-managed
deployment, #864 - a web-only push never rebuilds or restarts it).

### What promotes a change to preview

This is the decision #865 asked to be made and written down, not just
implemented. The issue laid out three candidates:

1. **Every push to `main`.** Preview is always "what main looks like" -
   the most useful thing to have, and a broken main becomes visible
   somewhere real within minutes instead of staying invisible until
   someone happens to look at CI. Costs a deploy per merge.
2. **A `preview-*` tag or manual dispatch.** Deliberate and cheap, but it
   can drift from main for days with nobody noticing - which is the
   failure mode that makes a preview environment worthless: a tester who
   trusts `preview.loombox.dev` to mean "current main" is wrong exactly
   when it matters most.
3. **A dedicated `preview` branch**, merged into on purpose. More
   ceremony, and it only earns that ceremony back if preview is meant to
   hold something _other_ than main. loombox is single-trunk - every
   change lands on `main` via a squash-merged PR, nothing else - so a
   `preview` branch would just be a second name for the same commits,
   with an extra manual merge step and nothing to show for it.

**Chosen: every push to `main`** (`.github/workflows/deploy-preview.yml`).
The "costs a deploy per merge" objection turns out not to hold once the
concurrency semantics are worked through, not just asserted: the workflow
runs in its own `preview-deploy` concurrency group with
`cancel-in-progress: false`, exactly like `deploy-prod.yml`'s own
`prod-deploy` group - and that file's own comment already documents the
behaviour this leans on: when a run is already in progress, GitHub queues
at most one more, and a further push while that one is still queued
_replaces_ it rather than adding a second queue entry. A burst of pushes
to `main` - #865's own body cites a real night where that would have been
close to twenty - collapses to at most one deploy in flight plus one
queued, never a backlog of twenty sequential ones working through a queue
an hour after the fact. `cancel-in-progress` stays `false`, not `true`,
for the same reason `deploy-prod.yml` keeps it `false`: by the time the
`deploy` job is running it may already have flipped `releases/current` or
be mid-rebuild, and cancelling there would abandon preview
half-updated with no health gate having run and no rollback triggered.

One more deliberate property of this choice: `deploy-preview.yml` does
**not** gate on `ci.yml` passing for the commit, unlike `deploy-prod.yml`'s
own CI-verification step. That is not an oversight - it is the same
"a broken main is instantly visible somewhere real" argument from option 1
above, taken seriously. Gating preview on green CI would recreate exactly
the option-2 failure mode (silent drift, just gated on a different signal
than a stale tag) for the one environment whose entire job is to show what
main currently does, including when that's broken. The only thing that
silently stops a preview deploy is the web build itself failing
(`build-web.yml`'s job never reaches `deploy`) - in that case preview
keeps serving the last commit whose web build succeeded, which is itself
an honest, visible signal (the in-app Build line, next section, stops
advancing) rather than a hidden one.

### The served commit is visible from the app itself

A preview whose contents are a mystery is a trap, so this isn't only
checkable by SSHing to prodbox. `svelte.config.js` sets `kit.version.name`
from `LOOMBOX_BUILD_COMMIT` (`build-web.yml` sets it to the commit being
built) - the same env var `packages/relay/src/build-identity.ts` already
reads at relay boot, reused rather than a second name. That one value now
drives three things at once, never independently:

- `client/_app/version.json`'s `.version` field - what
  `scripts/deploy-preview.sh`'s (and `scripts/deploy-prod.sh`'s) health
  gate compares between the just-unpacked release and what the public site
  actually serves.
- `$app/environment`'s `version` export, SvelteKit's own client-side
  mirror of the same value.
- Settings > Appearance's "Build \<sha>" line
  (`SettingsPage.svelte`, `data-testid="web-build-version"`) - a real user
  (or Lorenzo, without a terminal) can see exactly which commit their
  preview session is running.

### Bring up

```bash
cd /opt/apps/loombox-preview/deploy/web-preview
docker compose up -d --build
# health (through the loopback publish, before Caddy):
curl -fsS http://127.0.0.1:5188/
```

Add the Caddy site block (`deploy/web-preview/Caddyfile.snippet`) to
`/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy` (`caddy reload`
validates the new config before applying it, so a mistake here can't take
the other vhosts - including production's - down with it). DNS record:

| Type | Name                  | Content         | Proxied | TTL  |
| ---- | --------------------- | --------------- | ------- | ---- |
| A    | `preview.loombox.dev` | `152.53.44.195` | false   | auto |

Once it resolves, Caddy provisions the TLS cert on first request; verify:

```bash
curl -fsS https://preview.loombox.dev/
curl -fsS https://preview.loombox.dev/_app/version.json
```

### Rolling back by hand

Same shape as `CONTRIBUTING.md`'s prod rollback section, pointed at
preview's own tree:

```bash
ssh prodbox
cd /opt/apps/loombox-preview
prev=$(jq -r '.previousSha // empty' DEPLOYED.json)
[ -n "$prev" ] && [ -d "releases/$prev" ] || echo 'no previous release on this box'
ln -sfn "$prev" releases/current.tmp && mv -T releases/current.tmp releases/current
cd deploy/web-preview
docker compose -f docker-compose.yml -f docker-compose.live.yml \
  up -d --force-recreate --no-build --no-deps web
```

### Isolation from production

`deploy/web-preview/docker-compose.yml`'s `PUBLIC_LOOMBOX_RELAY_URL`
default is `wss://preview-relay.loombox.dev`, never production's
`relay.loombox.dev` - a preview web build that fell back to production's
relay would write preview traffic into the real database, exactly what
#863 exists to prevent. `scripts/deploy-preview.sh` only ever writes under
`/opt/apps/loombox-preview` (`LOOMBOX_PREVIEW_DEPLOY_DIR` if overridden for
a scratch rehearsal - distinct from `deploy-prod.sh`'s own
`LOOMBOX_DEPLOY_DIR`, no shared fallback between the two) and never reads
or writes anything under `/opt/apps/loombox`. Verify production's
containers never moved, before and after any preview deploy:
`docker ps -q | sort` run on prodbox before touching preview and again
after - `relay-relay-1` / `relay-postgres-1` / `web-web-1`'s container IDs
must be byte-identical.

## Status: preview only until device pairing lands

Device pairing - the recovery-code escrow / QR flow that gets a real Account
Master Key onto a second device (SPEC §8) - is still WIP: v1 scope today is
single-device, on-device AMK custody only, generated once per browser and
never wrapped for another device (see the doc comment on `AmkStorage` in
`apps/web/src/lib/amk-store.ts`). Until pairing lands, a deployment of this
app is a UI/preview: you can open it, point it at a relay, sign in, and see
the shell, but there's no way yet to bring a second device (e.g. a phone)
into an existing account's key custody. Deploy it to have the URL ready, not
as a finished product.
