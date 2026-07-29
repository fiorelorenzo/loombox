#!/usr/bin/env bash
#
# deploy-prod.sh — the tag-triggered production deploy. Runs ON prodbox, as
# user `prod`, invoked by .github/workflows/deploy-prod.yml's self-hosted
# `deploy` job. Not meant to be run from the devbox (that's scripts/
# deploy-web.sh, the fast iteration path — see its header).
#
# Usage (cwd must be a git checkout of the tag being deployed, e.g. what
# actions/checkout@v4 leaves in $GITHUB_WORKSPACE):
#   scripts/deploy-prod.sh <tag> <web-bundle-dir>
#
# <web-bundle-dir> is the contents of apps/web/build/, built on a GitHub-
# hosted runner (build-web job) and downloaded here as an artifact — this
# script never runs pnpm/node itself (the self-hosted runner has no system
# node on PATH; it only bundles one internally to run JS-based actions).
#
# What it does, in order:
#   1. rsync the checked-out tag's source into /opt/apps/loombox, excluding
#      (and thereby protecting) everything that only exists on the box.
#   2. Unpack the web bundle into releases/<sha>/ and atomically flip
#      releases/current to point at it (see docker-compose.live.yml for why
#      this indirection exists).
#   3. Decide, per service, whether its docker image needs a rebuild by
#      comparing content hashes against DEPLOYED.json's record of what was
#      last built from.
#   4. Health-gate the result against the real endpoints, including proof
#      the SERVED web bundle is the one just deployed (AGENTS.md: a green
#      curl is not proof the build ran — this box has silently served a
#      stale cached image before).
#   5. On any failure after the flip, roll back to the last known-good
#      release/image and exit non-zero. Before the flip, `set -e` alone is
#      enough: nothing live has changed yet, so there's nothing to undo.
#   6. Record DEPLOYED.json and prune old releases, but only once the health
#      gate has actually passed.
#
# Idempotent: re-running for the same tag re-syncs, re-unpacks over the same
# releases/<sha> dir, and re-flips a symlink that's already pointing there —
# all safe no-ops in substance. Also correct on a from-scratch box, before
# releases/ or DEPLOYED.json exist and the web container is still mounting
# the pre-pipeline apps/web/build path (see docker-compose.live.yml).
set -euo pipefail

TAG="${1:?usage: deploy-prod.sh <tag> <web-bundle-dir>}"
WEB_BUNDLE="${2:?usage: deploy-prod.sh <tag> <web-bundle-dir>}"
[ -f "$WEB_BUNDLE/client/_app/version.json" ] || {
  echo "ERROR: $WEB_BUNDLE doesn't look like an apps/web/build output (no client/_app/version.json)" >&2
  exit 1
}

REPO_ROOT="$(pwd)"
SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
ACTOR="${GITHUB_ACTOR:-$(whoami)}"

DEPLOY_DIR="${LOOMBOX_DEPLOY_DIR:-/opt/apps/loombox}"
RELEASES_DIR="$DEPLOY_DIR/releases"
DEPLOYED_JSON="$DEPLOY_DIR/DEPLOYED.json"
KEEP_RELEASES=5 # old releases/<sha> dirs to retain, so a rollback target always exists

echo "==> deploying tag=$TAG sha=$SHA actor=$ACTOR -> $DEPLOY_DIR"

# --- 1. sync source -------------------------------------------------------
#
# --checksum (not just size+mtime): a fresh checkout's mtimes and prodbox's
# existing tree can legitimately coincide in size for a small changed file,
# which would make rsync's default quick-check skip it as "unchanged" —
# reproduced this once in a scratch test (two 32-byte compose-file variants,
# same second, quick-check skipped the real content change). Content-hash
# comparison costs a bit of CPU on a repo this size; correctness for the
# thing that ends up running in prod is worth it.
#
# Every one of the anchored (/-prefixed) excludes below protects something
# that is NOT in git and would otherwise be deleted by --delete: relay's
# .env (BETTER_AUTH_SECRET, POSTGRES_PASSWORD — losing it invalidates every
# login session), its backups/, the releases/ tree and DEPLOYED.json this
# script itself owns, and the pre-pipeline apps/web/build bind-mount target.
# Verified empirically (scratch src/dst trees, real secrets-shaped files):
# all five survive an --exclude --delete sync untouched while tracked files
# elsewhere, including a genuinely obsolete one, sync and delete correctly.
rsync -a --delete --checksum \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '/deploy/relay/.env' \
  --exclude '/deploy/relay/backups' \
  --exclude '/releases' \
  --exclude '/DEPLOYED.json' \
  --exclude '/apps/web/build' \
  "$REPO_ROOT"/ "$DEPLOY_DIR"/

mkdir -p "$RELEASES_DIR"

# --- 2. gather what we need before touching anything live ------------------

PREV_SHA=""
if [ -L "$RELEASES_DIR/current" ] && [ -e "$RELEASES_DIR/current" ]; then
  PREV_SHA="$(basename "$(readlink "$RELEASES_DIR/current")")"
fi
echo "==> previous release: ${PREV_SHA:-<none, first deploy under this pipeline>}"

# Deterministic content hash of one or more files/dirs: sorted per-file
# sha256, then hash that list. A rename or an added/removed file changes the
# result exactly like an edited one would; only mtimes are ignored.
hash_paths() {
  find "$@" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
}

cd "$DEPLOY_DIR"
cur_lockfile_hash="$(hash_paths pnpm-lock.yaml)"
cur_webpkg_hash="$(hash_paths apps/web/package.json)"
# packages/relay/Dockerfile is inside packages/relay already, so it's
# covered without listing it separately.
cur_relaysrc_hash="$(hash_paths packages/relay packages/protocol packages/crypto packages/shared)"

# Empty when DEPLOYED.json doesn't exist yet or never recorded this key —
# which never equals a real sha256, so a from-scratch box forces exactly one
# rebuild of each image (the only way to KNOW the box's current images match
# this tag's deps) and every deploy after that is back to the fast path.
read_prev_hash() {
  [ -f "$DEPLOYED_JSON" ] && jq -r "$1 // \"\"" "$DEPLOYED_JSON" || echo ""
}
prev_lockfile_hash="$(read_prev_hash .inputs.lockfile)"
prev_webpkg_hash="$(read_prev_hash .inputs.webPkg)"
prev_relaysrc_hash="$(read_prev_hash .inputs.relaySrc)"

web_rebuild=false
if [ "$cur_lockfile_hash" != "$prev_lockfile_hash" ] || [ "$cur_webpkg_hash" != "$prev_webpkg_hash" ]; then
  web_rebuild=true
fi

relay_rebuild=false
if [ "$cur_lockfile_hash" != "$prev_lockfile_hash" ] || [ "$cur_relaysrc_hash" != "$prev_relaysrc_hash" ]; then
  relay_rebuild=true
fi
echo "==> web_rebuild=$web_rebuild relay_rebuild=$relay_rebuild"

# Tag the relay's current (pre-deploy) image as a rollback point BEFORE we
# touch it. Cheap and always safe to do even if the build below never runs
# into trouble; doing it here (not inside the mutation block) means rollback
# never depends on state computed inside the subshell below.
RELAY_ROLLBACK_TAGGED=false
RELAY_IMAGE_REF=""
if [ "$relay_rebuild" = true ]; then
  RELAY_IMAGE_REF="$(cd "$DEPLOY_DIR/deploy/relay" && docker compose images relay --format json | jq -r '.[0] | "\(.Repository):\(.Tag)"')"
  if [ -n "$RELAY_IMAGE_REF" ] && [ "$RELAY_IMAGE_REF" != "null:null" ]; then
    echo "==> tagging current relay image ($RELAY_IMAGE_REF) as a rollback point"
    docker tag "$RELAY_IMAGE_REF" "${RELAY_IMAGE_REF}-rollback"
    RELAY_ROLLBACK_TAGGED=true
  fi
fi

# --- 3. unpack the web bundle (still not live -- nothing points at it yet) -

RELEASE_DIR="$RELEASES_DIR/$SHA"
echo "==> unpacking web bundle into releases/$SHA"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
cp -a "$WEB_BUNDLE"/. "$RELEASE_DIR"/

# --- rollback -- everything from here on can undo itself -------------------
#
# restores the previous symlink target (if any) and the previous relay image
# (if this run tagged one), each with an explicit recreate so a plain
# `docker compose up` config-drift skip can never leave the rollback half-
# applied. Never aborts partway (every risky step is its own `if`, per the
# same set -e-with-a-function gotcha documented in ~/Progetti/pitchbox/
# scripts/deploy.sh's prune_backups) so a rollback failure is reported, not
# swallowed by an early return.
rollback() {
  echo "==> ROLLING BACK to the last known-good release" >&2
  if [ -n "$PREV_SHA" ]; then
    echo "   restoring releases/current -> $PREV_SHA" >&2
    if ln -sfn "$PREV_SHA" "$RELEASES_DIR/current"; then
      if ! (cd "$DEPLOY_DIR/deploy/web" && docker compose -f docker-compose.yml -f docker-compose.live.yml up -d --force-recreate --no-build --no-deps web); then
        echo "   WARNING: web recreate failed during rollback -- check it by hand" >&2
      fi
    else
      echo "   WARNING: failed to restore the releases/current symlink -- check it by hand" >&2
    fi
  else
    echo "   no previous release recorded (this was the first deploy) -- nothing to restore web to; the old apps/web/build bind-mount contents are still on disk if you need to fall all the way back by hand" >&2
  fi

  if [ "$RELAY_ROLLBACK_TAGGED" = true ]; then
    echo "   restoring relay image $RELAY_IMAGE_REF to its pre-deploy state" >&2
    if docker tag "${RELAY_IMAGE_REF}-rollback" "$RELAY_IMAGE_REF"; then
      if ! (cd "$DEPLOY_DIR/deploy/relay" && docker compose up -d --force-recreate --no-build --no-deps relay); then
        echo "   WARNING: relay recreate failed during rollback -- check it by hand" >&2
      fi
    else
      echo "   WARNING: failed to restore the relay image tag -- check it by hand" >&2
    fi
  fi
}

# Verifies the deploy, not just that commands returned 0. Only sha256sum,
# curl and jq -- no node/pnpm (the self-hosted runner has none on PATH).
health_gate() {
  echo "==> health gate: relay /health"
  local ok=0 _i code served artifact
  for _i in $(seq 1 20); do
    if curl -fsS --max-time 5 http://127.0.0.1:5185/health 2>/dev/null | grep -q '"status":"ok"'; then
      ok=1
      break
    fi
    sleep 3
  done
  if [ "$ok" != 1 ]; then
    echo "ERROR: relay /health never came up healthy on 127.0.0.1:5185" >&2
    return 1
  fi

  echo "==> health gate: https://app.loombox.dev/"
  ok=0
  code=000
  for _i in $(seq 1 20); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://app.loombox.dev/ 2>/dev/null || echo 000)"
    if [ "$code" = 200 ]; then
      ok=1
      break
    fi
    sleep 3
  done
  if [ "$ok" != 1 ]; then
    echo "ERROR: https://app.loombox.dev/ never returned 200 (last: $code)" >&2
    return 1
  fi

  # AGENTS.md: a stale docker layer has served an old bundle behind a green
  # curl before, so 200 OK alone proves nothing. Compare SvelteKit's own
  # build-identity marker (client/_app/version.json, a fresh value baked in
  # every build) between the artifact we just unpacked and what the public
  # site actually serves -- the only way these match is if this exact build
  # is live.
  echo "==> health gate: served bundle matches this deploy's artifact"
  artifact="$(jq -r '.version' "$RELEASE_DIR/client/_app/version.json")"
  ok=0
  served=""
  for _i in $(seq 1 10); do
    served="$(curl -fsS -H 'Cache-Control: no-cache' --max-time 10 https://app.loombox.dev/_app/version.json 2>/dev/null | jq -r '.version // empty')"
    if [ "$served" = "$artifact" ]; then
      ok=1
      break
    fi
    sleep 3
  done
  if [ "$ok" != 1 ]; then
    echo "ERROR: served _app/version.json ($served) != deployed artifact ($artifact) -- prod is still serving a stale build" >&2
    return 1
  fi

  echo "==> health gate passed (relay healthy, app.loombox.dev live, served build == $artifact)"
}

# --- 4/5. flip + rebuild-if-needed + recreate, all-or-nothing --------------
#
# Runs in a subshell so a failure anywhere in this span (flip, build,
# recreate, health gate) is caught in one place instead of needing its own
# explicit check after every step. The subshell runs as a PLAIN STATEMENT
# first, with $? captured right after -- deliberately NOT `if ( ... );
# then`. That distinction actually matters: bash suspends `set -e`
# enforcement for every command inside a compound command being used as an
# if/while CONDITION, and that suspension propagates into a subshell placed
# there even when the subshell sets `-e` itself again on its own first
# line. Caught this empirically: a failing `docker compose build` inside
# `if ( set -e; ...; docker compose build ...; ... ); then` was silently
# ignored and the script sailed on to report success and write DEPLOYED.json
# for a broken image. Running the subshell as its own statement (with the
# OUTER shell's `-e` suspended around just that one statement, restored
# right after) and checking the captured exit code afterward doesn't have
# that problem -- verified with the same repro.
set +e
(
  set -euo pipefail
  echo "==> flipping releases/current -> $SHA"
  ln -sfn "$SHA" "$RELEASES_DIR/current"
  # Verified empirically on this box (scratch compose project, symlink
  # flipped under a running container): `docker compose restart` is enough
  # to pick up a flipped bind-mount symlink target -- Docker re-resolves the
  # mount source every time a container starts, not just at `create`/`up`.
  # We still use --force-recreate rather than plain `restart` below, because
  # the FIRST run under this pipeline also changes the mount's *source path*
  # itself (docker-compose.live.yml moving from apps/web/build to
  # releases/current), which restart would never pick up -- it never
  # re-reads compose config, only the already-configured mount. One
  # unconditional recreate command is correct on every run, first or not,
  # instead of branching on "did the compose file change this time".
  cd "$DEPLOY_DIR/deploy/web"
  if [ "$web_rebuild" = true ]; then
    echo "==> web deps changed (pnpm-lock.yaml or apps/web/package.json) -- rebuilding the image"
    # --no-cache: AGENTS.md -- `docker compose build` on this shared box has
    # repeatedly served a stale cached layer (a rebuild silently reused an
    # old source COPY layer). The exact root cause was never pinned down and
    # doesn't need to be: --no-cache guarantees every layer, including the
    # COPY, is rebuilt from what's actually on disk. Costs a slower build,
    # but this only runs when a dependency changed, which is rare.
    docker compose build --no-cache web
  fi
  docker compose -f docker-compose.yml -f docker-compose.live.yml \
    up -d --force-recreate --no-build --no-deps web

  cd "$DEPLOY_DIR/deploy/relay"
  if [ "$relay_rebuild" = true ]; then
    echo "==> relay source changed -- rebuilding the image"
    # Same stale-layer defense as web, and for the same underlying box.
    docker compose build --no-cache relay
    docker compose up -d --force-recreate --no-build --no-deps relay
  else
    # The relay has no bind-mount fast path (its source is baked into the
    # image, unlike web) -- but most releases don't touch it at all, and
    # restarting it for no reason drops every live WebSocket connection on
    # the box. So: touch nothing, not even a restart, when nothing relay-
    # relevant changed.
    echo "==> relay unchanged -- leaving it running (a restart would drop every live WebSocket)"
  fi

  health_gate
)
deploy_rc=$?
set -e

if [ "$deploy_rc" -ne 0 ]; then
  echo "==> DEPLOY FAILED after the release flip" >&2
  rollback
  echo "==> rolled back; prod should be back on the last known-good release. Exiting non-zero." >&2
  exit 1
fi
echo "==> deploy mutation + health gate succeeded"

# --- 6. record + prune, only now that the health gate actually passed ------

jq -n \
  --arg tag "$TAG" \
  --arg sha "$SHA" \
  --arg deployedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg actor "$ACTOR" \
  --arg previousSha "$PREV_SHA" \
  --arg lockfile "$cur_lockfile_hash" \
  --arg webPkg "$cur_webpkg_hash" \
  --arg relaySrc "$cur_relaysrc_hash" \
  '{
    tag: $tag,
    sha: $sha,
    deployedAt: $deployedAt,
    actor: $actor,
    previousSha: (if $previousSha == "" then null else $previousSha end),
    inputs: { lockfile: $lockfile, webPkg: $webPkg, relaySrc: $relaySrc }
  }' >"$DEPLOYED_JSON.tmp"
mv "$DEPLOYED_JSON.tmp" "$DEPLOYED_JSON"
echo "==> wrote $DEPLOYED_JSON"

# Best-effort cleanup, never a deploy gate: ordered oldest-to-newest is
# meaningless for sha-named dirs, so this orders by mtime instead (set when
# each release was unpacked above), newest first, and drops everything past
# the keep window. Mirrors ~/Progetti/pitchbox/scripts/deploy.sh's
# prune_backups, including its explicit `return 0` -- a loop whose last
# iteration is a false `[ test ]` would otherwise make this function, and
# thus the whole script, exit non-zero under `set -e` for a no-op prune.
prune_releases() {
  local keep="$KEEP_RELEASES" dirs=() d i=0
  echo "==> pruning old releases beyond the last $keep"
  while IFS= read -r d; do dirs+=("$d"); done < <(
    find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2-
  )
  for d in "${dirs[@]}"; do
    i=$((i + 1))
    if [ "$i" -gt "$keep" ] && [ "$d" != "$SHA" ]; then
      echo "   removing releases/$d"
      rm -rf "${RELEASES_DIR:?}/${d:?}" || echo "   WARNING: failed to remove releases/$d" >&2
    fi
  done
  return 0
}
prune_releases

echo "==> DONE: $TAG (sha $SHA) is live"
