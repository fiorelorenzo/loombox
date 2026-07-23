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
