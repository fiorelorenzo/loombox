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
# real relay, real OAuth) without cutting a release for every fix.
#
# It never overwrites the tagged release in place. Doing that would leave
# DEPLOYED.json still naming the tag while the bytes on disk were something
# else, which is exactly the "what is actually deployed?" question this whole
# layout exists to answer. Instead it unpacks into its own
# releases/iter-<sha>-<stamp> directory and flips releases/current at it, so
# the deviation is visible in one `ls -l`, the tagged release stays intact
# beside it, and going back is a flip (this script prints the command).
#
# Builds the SvelteKit PWA locally (fast, no box contention), rsyncs the
# adapter-node `build/` into a new release directory, and points the running
# container at it. NO Docker image build: the prod web container bind-mounts
# the release directory from the host (deploy/web/docker-compose.live.yml),
# so shipping new code is just rsync + recreate. This sidesteps the slow,
# cache-prone `docker compose build` on the shared box.
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

ITER_RELEASE="iter-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
echo ">> unpack into releases/$ITER_RELEASE and flip current at it"
rsync -az --delete --timeout=110 -e 'ssh -o BatchMode=yes' \
  apps/web/build/ "$PRODBOX:$DEPLOY_DIR/releases/$ITER_RELEASE/"

# `up -d --force-recreate`, not `restart`: the mount SOURCE changes here (a
# different release directory), and a restart re-resolves the symlink but
# never re-reads compose config, so the container has to be recreated for the
# new target to take. scripts/deploy-prod.sh's flip site has the same note.
ssh -o BatchMode=yes -o ConnectTimeout=60 "$PRODBOX" "
  set -e
  cd $DEPLOY_DIR/releases
  ln -sfn '$ITER_RELEASE' current.tmp && mv -T current.tmp current
  cd $DEPLOY_DIR/deploy/web
  docker compose -f docker-compose.yml -f docker-compose.live.yml up -d \
    --force-recreate --no-build --no-deps web
" 2>&1 | tail -1

echo ">> verify"
sleep 6
for _ in $(seq 1 8); do
  s="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://app.loombox.dev/ 2>/dev/null)"
  [ "$s" = "200" ] && break
  sleep 4
done
echo ">> app.loombox.dev: $s"

# A 200 is not proof the new bundle is live: AGENTS.md records this box
# serving a stale build behind a green curl. Compare SvelteKit's own build
# identity, the same check scripts/deploy-prod.sh's health gate makes.
want="$(jq -r .version apps/web/build/client/_app/version.json)"
got="$(curl -fsS -H 'Cache-Control: no-cache' --max-time 10 \
  https://app.loombox.dev/_app/version.json 2>/dev/null | jq -r '.version // empty')"
if [ "$want" = "$got" ]; then
  echo ">> served build == this build ($want)"
else
  echo "!! served build ($got) is NOT this build ($want)" >&2
  exit 1
fi

cat <<EOF

>> prod is now off-tag, serving releases/$ITER_RELEASE
   DEPLOYED.json still names the last tagged deploy, which is true of the
   tag, not of these bytes. To put the tagged release back:
     ssh $PRODBOX "cd $DEPLOY_DIR/releases && ln -sfn \\\$(jq -r .sha $DEPLOY_DIR/DEPLOYED.json) current.tmp && mv -T current.tmp current && cd $DEPLOY_DIR/deploy/web && docker compose -f docker-compose.yml -f docker-compose.live.yml up -d --force-recreate --no-build --no-deps web"
EOF
