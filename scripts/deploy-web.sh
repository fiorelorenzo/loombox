#!/usr/bin/env bash
#
# deploy-web.sh — fast web deploy to app.loombox.dev, from the devbox.
#
# Builds the SvelteKit PWA locally (fast, no box contention), rsyncs the
# adapter-node `build/` to prodbox, and restarts the web container. NO Docker
# image build: the prod web container bind-mounts the host's build/ dir
# (deploy/web/docker-compose.live.yml on prodbox), so shipping new code is just
# rsync + restart. This sidesteps the slow, cache-prone `docker compose build`
# on the shared box.
#
# Usage (from the devbox, on the branch whose web you want live):
#   scripts/deploy-web.sh
#
# One-time prerequisite (already done): the prodbox web stack was recreated with
# the bind-mount overlay:
#   docker compose -f docker-compose.yml -f docker-compose.live.yml up -d \
#     --no-build --force-recreate web
#
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
PRODBOX="${PRODBOX:-prodbox}"
HOST_BUILD_DIR="/opt/apps/loombox/apps/web/build"

cd "$REPO"

echo ">> build web (@loombox/web)"
pnpm --filter @loombox/web build >/dev/null
echo "   built $(git rev-parse --short HEAD)"

echo ">> rsync build/ -> $PRODBOX:$HOST_BUILD_DIR"
rsync -az --delete --timeout=110 -e 'ssh -o BatchMode=yes' \
  apps/web/build/ "$PRODBOX:$HOST_BUILD_DIR/"

echo ">> restart web container"
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
