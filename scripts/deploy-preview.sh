#!/usr/bin/env bash
#
# deploy-preview.sh — the push-to-main-triggered PREVIEW deploy (issue
# #865, epic #863). Runs ON prodbox, as user `prod`, invoked by
# .github/workflows/deploy-preview.yml's self-hosted `deploy` job. Not
# meant to be run from the devbox.
#
# Usage (cwd must be a git checkout of the commit being deployed, e.g. what
# actions/checkout@v4 leaves in $GITHUB_WORKSPACE):
#   scripts/deploy-preview.sh <web-bundle-dir>
#
# <web-bundle-dir> is the contents of apps/web/build/, built on a GitHub-
# hosted runner (the shared build-web.yml reusable workflow) and downloaded
# here as an artifact — this script never runs pnpm/node itself, same as
# deploy-prod.sh (the self-hosted runner has no system node on PATH).
#
# WEB ONLY, deliberately: preview's relay (deploy/relay-preview/, #864) is
# a separate, manually-managed deployment. This script never touches it,
# never rebuilds its image, never restarts its container — the trigger
# this issue had to choose (push to main, see CONTRIBUTING.md's "Deploying
# to preview" for the full argument) only applies to how fast the WEB half
# should move; the relay has no equivalent "promote automatically" case
# yet, and restarting it for a web-only push would drop every live
# WebSocket connection on preview for no reason.
#
# Same shape as deploy-prod.sh on purpose — releases/<sha> + a `current`
# symlink, the same served-build-identity health gate, the same
# rollback-on-failure — preview is meant to be deployed the way prod is,
# not through a second, divergent mechanism. Differences from
# deploy-prod.sh, and why:
#   - no TAG argument: preview promotes off main's HEAD commit directly
#     (this issue's own decision), not a hand-cut tag, so there's no
#     human-facing tag name to thread through DEPLOYED.json.
#   - no relay rebuild/restart step or CI-green check: see above and
#     CONTRIBUTING.md.
#   - DEPLOY_DIR defaults to /opt/apps/loombox-preview, never
#     /opt/apps/loombox — production's tree is never touched or even read
#     by this script. LOOMBOX_PREVIEW_DEPLOY_DIR (distinct from
#     deploy-prod.sh's own LOOMBOX_DEPLOY_DIR — no shared fallback between
#     the two, so a typo here can never resolve into production's path)
#     overrides it for a scratch rehearsal.
#
# Idempotent: re-running for the same commit re-syncs, re-unpacks over the
# same releases/<sha> dir, and re-flips a symlink that's already pointing
# there — all safe no-ops in substance. Also correct on a from-scratch
# preview deploy dir, before releases/ or DEPLOYED.json exist.
set -euo pipefail

WEB_BUNDLE="${1:?usage: deploy-preview.sh <web-bundle-dir>}"
[ -f "$WEB_BUNDLE/client/_app/version.json" ] || {
  echo "ERROR: $WEB_BUNDLE doesn't look like an apps/web/build output (no client/_app/version.json)" >&2
  exit 1
}

REPO_ROOT="$(pwd)"
SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
ACTOR="${GITHUB_ACTOR:-$(whoami)}"

DEPLOY_DIR="${LOOMBOX_PREVIEW_DEPLOY_DIR:-/opt/apps/loombox-preview}"
RELEASES_DIR="$DEPLOY_DIR/releases"
DEPLOYED_JSON="$DEPLOY_DIR/DEPLOYED.json"
KEEP_RELEASES=5 # old releases/<sha> dirs to retain, so a rollback target always exists

echo "==> deploying preview sha=$SHA actor=$ACTOR -> $DEPLOY_DIR"

# --- 1. sync source -------------------------------------------------------
#
# Same DEPLOY_DIR tree also holds deploy/relay-preview/'s own live,
# untracked state (#864's .env, its backups/) — protect those exactly like
# deploy-prod.sh protects production's relay .env, plus this script's own
# releases/DEPLOYED.json state. See deploy-prod.sh's own comment on
# --checksum for why quick-check (size+mtime) isn't good enough here.
rsync -a --delete --checksum \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '/deploy/relay-preview/.env' \
  --exclude '/deploy/relay-preview/backups' \
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

# Deterministic content hash, same helper as deploy-prod.sh's own
# hash_paths — a rename or an added/removed file changes the result exactly
# like an edited one would; only mtimes are ignored.
hash_paths() {
  find "$@" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
}

cd "$DEPLOY_DIR"
cur_lockfile_hash="$(hash_paths pnpm-lock.yaml)"
cur_webpkg_hash="$(hash_paths apps/web/package.json)"

read_prev_hash() {
  [ -f "$DEPLOYED_JSON" ] && jq -r "$1 // \"\"" "$DEPLOYED_JSON" || echo ""
}
prev_lockfile_hash="$(read_prev_hash .inputs.lockfile)"
prev_webpkg_hash="$(read_prev_hash .inputs.webPkg)"

web_rebuild=false
if [ "$cur_lockfile_hash" != "$prev_lockfile_hash" ] || [ "$cur_webpkg_hash" != "$prev_webpkg_hash" ]; then
  web_rebuild=true
fi
echo "==> web_rebuild=$web_rebuild"

# --- 3. unpack the web bundle (still not live -- nothing points at it yet) -

RELEASE_DIR="$RELEASES_DIR/$SHA"
echo "==> unpacking web bundle into releases/$SHA"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
cp -a "$WEB_BUNDLE"/. "$RELEASE_DIR"/

# --- rollback -- everything from here on can undo itself -------------------

rollback() {
  echo "==> ROLLING BACK preview to the last known-good release" >&2
  if [ -n "$PREV_SHA" ]; then
    echo "   restoring releases/current -> $PREV_SHA" >&2
    if ln -sfn "$PREV_SHA" "$RELEASES_DIR/current"; then
      if ! (cd "$DEPLOY_DIR/deploy/web-preview" && docker compose -f docker-compose.yml -f docker-compose.live.yml up -d --force-recreate --no-build --no-deps web); then
        echo "   WARNING: web-preview recreate failed during rollback -- check it by hand" >&2
      fi
    else
      echo "   WARNING: failed to restore the releases/current symlink -- check it by hand" >&2
    fi
  else
    echo "   no previous release recorded (this was the first deploy) -- nothing to restore to" >&2
  fi
}

# Verifies the deploy, not just that commands returned 0 — same "a green
# curl is not proof the build ran" reasoning as deploy-prod.sh's own
# health_gate (AGENTS.md: prodbox has silently served a stale cached build
# before). Only curl and jq, no node/pnpm.
health_gate() {
  echo "==> health gate: https://preview.loombox.dev/"
  local ok=0 _i code served artifact
  code=000
  for _i in $(seq 1 20); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://preview.loombox.dev/ 2>/dev/null || echo 000)"
    if [ "$code" = 200 ]; then
      ok=1
      break
    fi
    sleep 3
  done
  if [ "$ok" != 1 ]; then
    echo "ERROR: https://preview.loombox.dev/ never returned 200 (last: $code)" >&2
    return 1
  fi

  echo "==> health gate: served bundle matches this deploy's artifact"
  artifact="$(jq -r '.version' "$RELEASE_DIR/client/_app/version.json")"
  ok=0
  served=""
  for _i in $(seq 1 10); do
    served="$(curl -fsS -H 'Cache-Control: no-cache' --max-time 10 https://preview.loombox.dev/_app/version.json 2>/dev/null | jq -r '.version // empty')"
    if [ "$served" = "$artifact" ]; then
      ok=1
      break
    fi
    sleep 3
  done
  if [ "$ok" != 1 ]; then
    echo "ERROR: served _app/version.json ($served) != deployed artifact ($artifact) -- preview is still serving a stale build" >&2
    return 1
  fi

  echo "==> health gate passed (preview.loombox.dev live, served build == $artifact)"
}

# --- 4/5. flip + rebuild-if-needed + recreate, all-or-nothing --------------
#
# Same set+e/subshell/set-e dance as deploy-prod.sh, and for the identical
# reason documented there in full: a failing command inside a subshell used
# as an `if ( ... )` condition silently loses `set -e` enforcement, verified
# empirically on that script. Running the subshell as its own statement and
# checking $? afterward doesn't have that problem.
set +e
(
  set -euo pipefail
  echo "==> flipping releases/current -> $SHA"
  ln -sfn "$SHA" "$RELEASES_DIR/current"
  cd "$DEPLOY_DIR/deploy/web-preview"
  if [ "$web_rebuild" = true ]; then
    echo "==> web deps changed (pnpm-lock.yaml or apps/web/package.json) -- rebuilding the image"
    # --no-cache: same stale-layer defense as deploy-prod.sh on this same
    # shared box (AGENTS.md).
    docker compose build --no-cache web
  fi
  docker compose -f docker-compose.yml -f docker-compose.live.yml \
    up -d --force-recreate --no-build --no-deps web

  health_gate
)
deploy_rc=$?
set -e

if [ "$deploy_rc" -ne 0 ]; then
  echo "==> DEPLOY FAILED after the release flip" >&2
  rollback
  echo "==> rolled back; preview should be back on the last known-good release. Exiting non-zero." >&2
  exit 1
fi
echo "==> deploy mutation + health gate succeeded"

# --- 6. record + prune, only now that the health gate actually passed ------

jq -n \
  --arg sha "$SHA" \
  --arg deployedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg actor "$ACTOR" \
  --arg previousSha "$PREV_SHA" \
  --arg lockfile "$cur_lockfile_hash" \
  --arg webPkg "$cur_webpkg_hash" \
  '{
    sha: $sha,
    deployedAt: $deployedAt,
    actor: $actor,
    previousSha: (if $previousSha == "" then null else $previousSha end),
    inputs: { lockfile: $lockfile, webPkg: $webPkg }
  }' >"$DEPLOYED_JSON.tmp"
mv "$DEPLOYED_JSON.tmp" "$DEPLOYED_JSON"
echo "==> wrote $DEPLOYED_JSON"

# Best-effort cleanup, never a deploy gate — same ordering and the same
# explicit `return 0` as deploy-prod.sh's own prune_releases, for the
# identical reason (a loop whose last iteration is a false `[ test ]` would
# otherwise make this function, and thus the whole script, exit non-zero
# under `set -e` for a no-op prune).
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

echo "==> DONE: preview is now serving $SHA"
