#!/usr/bin/env bash
#
# deploy-web.sh — fast web ITERATION deploy to app.loombox.dev, from the
# devbox.
#
# This is NOT the official route to prod. That's the tag pipeline: push a
# `vX.Y.Z` tag and .github/workflows/deploy-prod.yml + scripts/deploy-prod.sh
# take it from there (see CONTRIBUTING.md) — that's the one that health-gates
# the result and records what's live in DEPLOYED.json. This script exists so
# you can iterate on the web app against real prod infra (real Postgres,
# real relay, real OAuth) without cutting a release for every fix. It
# overwrites whatever release is CURRENTLY live IN PLACE — the next real tag
# deploy unpacks a fresh releases/<sha> and cleanly supersedes whatever this
# script left behind.
#
# Builds the SvelteKit PWA locally (fast, no box contention), rsyncs the
# adapter-node `build/` over the release directory releases/current already
# points at, and restarts the web container. NO Docker image build: the prod
# web container bind-mounts that release dir from the host
# (deploy/web/docker-compose.live.yml), so shipping new code is just rsync +
# restart. This sidesteps the slow, cache-prone `docker compose build` on
# the shared box.
#
# Usage (from the devbox, on the branch whose web you want live):
#   scripts/deploy-web.sh
#
# Prerequisite: at least one real tag deploy must already have run, so
# releases/current exists and points at a real build — there is nothing to
# iterate on top of otherwise. If you're bringing the box up from scratch,
# push a tag first.
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
PRODBOX="${PRODBOX:-prodbox}"
DEPLOY_DIR="/opt/apps/loombox"

cd "$REPO"

echo ">> resolve releases/current on $PRODBOX"
# Resolve the symlink AND confirm it points at a real build (has a client/
# dir), in one round trip, rather than trusting a bare readlink: a box that
# has never run the tag pipeline has no releases/ tree at all, and rsyncing
# apps/web/build/ into a path the web container isn't even mounting would
# silently do nothing useful.
HOST_BUILD_DIR="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$PRODBOX" "
  set -e
  t=\$(readlink -f '$DEPLOY_DIR/releases/current' 2>/dev/null) || exit 1
  [ -d \"\$t/client\" ] || exit 1
  echo \"\$t\"
" 2>/dev/null || true)"
if [ -z "$HOST_BUILD_DIR" ]; then
  echo "ERROR: $PRODBOX:$DEPLOY_DIR/releases/current doesn't point at a real release yet." >&2
  echo "       Push a v* tag first (see CONTRIBUTING.md#deploying-to-prod) to run the" >&2
  echo "       tag pipeline once — this script only iterates on top of an existing release." >&2
  exit 1
fi
echo "   releases/current -> $HOST_BUILD_DIR"

echo ">> build web (@loombox/web)"
pnpm --filter @loombox/web build >/dev/null
echo "   built $(git rev-parse --short HEAD)"

echo ">> rsync build/ -> $PRODBOX:$HOST_BUILD_DIR"
rsync -az --delete --timeout=110 -e 'ssh -o BatchMode=yes' \
  apps/web/build/ "$PRODBOX:$HOST_BUILD_DIR/"

echo ">> restart web container"
# A plain restart is enough here (verified empirically — see
# scripts/deploy-prod.sh's comment at its flip site): it's the same release
# directory the container already has mounted, just with new files rsynced
# into it, so this is only about restarting the Node process to pick up
# fresh JS, not about re-resolving a changed mount source.
ssh -o BatchMode=yes -o ConnectTimeout=25 "$PRODBOX" \
  'cd /opt/apps/loombox/deploy/web && docker compose -f docker-compose.yml -f docker-compose.live.yml restart web' \
  2>&1 | tail -1

echo ">> verify"
sleep 6
for _ in $(seq 1 8); do
  s="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://app.loombox.dev/ 2>/dev/null)"
  [ "$s" = "200" ] && break
  sleep 4
done
echo ">> app.loombox.dev: $s"
