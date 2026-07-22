# syntax=docker/dockerfile:1
#
# Production image for the loombox web PWA (apps/web, SvelteKit +
# @sveltejs/adapter-node), served behind prodbox's Caddy at
# https://app.loombox.dev (deploy/web/README.md).
#
# The build context is the repo ROOT (mirrors packages/relay/Dockerfile) so
# pnpm can resolve the workspace:
#   docker build -f apps/web/Dockerfile -t loombox-web .
#
# Runtime env (deploy/web/docker-compose.yml): ORIGIN (required -
# adapter-node's CSRF/form-action check needs the real public origin behind a
# reverse proxy, https://app.loombox.dev in prod), PORT/HOST (default
# 3000/0.0.0.0 below, both overridable).
#
# No relay URL env: the PWA has an in-UI "Relay URL" field (+page.svelte,
# `RELAY_URL_STORAGE_KEY = 'loombox:relay-url'`, persisted to localStorage),
# defaulting client-side to `ws://127.0.0.1:8787/ws` until the operator types
# `wss://relay.loombox.dev`. There is no build-time/PUBLIC_ env hook for this
# in the app today (SPEC's disposable v1 relay model - see the comment above
# `DEFAULT_RELAY_URL` in that file), so this image does not invent one; a
# deployed instance is a relay-URL-entry UI until pairing lands (see the repo
# README's pending-work note).
#
# Why the runtime stage keeps the full (dev+prod) node_modules instead of a
# --prod-pruned install, unlike packages/relay/Dockerfile:
# adapter-node's built server (apps/web/build/index.js and its chunks) still
# imports parts of @sveltejs/kit (`@sveltejs/kit/node`, `/internal`) and
# `svelte` itself unbundled at runtime, even though both are plain
# devDependencies by SvelteKit's own project convention here, not
# "dependencies". Verified on the devbox: `pnpm install --frozen-lockfile
# --prod --filter @loombox/web...` can't even get through `svelte-kit sync`
# (the binary isn't installed), and a matching `pnpm prune --prod` after
# build removes the same packages the built server needs at boot. So instead
# of pruning, the install below is scoped with `--filter @loombox/web...`
# (this app + its own workspace dependency subgraph - crypto/protocol/
# providers-core, plus @loombox/relay, a test-only devDependency here) rather
# than the full 15-package monorepo, which is the leanness lever that *is*
# safe to pull. The multi-stage split still earns its keep: build tools
# (python3/make/g++, needed to compile better-sqlite3 - itself only a
# test-only devDependency, never imported by the production bundle, see the
# grep-verified note in deploy/web/README.md) stay in the build stage only.
#
# Both stages use the same node:22-alpine base so any native addon built in
# the build stage (better-sqlite3) stays ABI-compatible with the runtime
# stage's musl libc - mixing glibc/musl across stages would risk an "invalid
# ELF header" crash if that code path were ever touched.

FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate
WORKDIR /app

COPY . .

# Scoped to @loombox/web + its own workspace dependency subgraph, not the
# full monorepo (see the comment block above). No --prod: adapter-node's
# output needs its devDependencies (@sveltejs/kit, svelte) present too.
RUN pnpm install --frozen-lockfile --filter @loombox/web...

RUN pnpm --filter @loombox/web build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -S loombox && adduser -S loombox -G loombox

# node_modules at both the workspace root (pnpm's content-addressable store
# + hoisted symlink targets) and apps/web/ (the workspace-local symlinks
# pointing into it) are needed together - Node's resolver walks up from
# apps/web/build/ through apps/web/node_modules to node_modules.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/build ./apps/web/build

RUN chown -R loombox:loombox /app
USER loombox

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

CMD ["node", "apps/web/build/index.js"]
