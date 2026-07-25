#!/usr/bin/env bash
#
# mac-desktop.sh — launch the loombox desktop app on the Mac, from the devbox.
#
# Run this FROM THE DEVBOX. It publishes the branch we're developing on, updates
# the Mac's loombox checkout to it, reinstalls deps, stops any running dev
# instance, and (re)launches the Electron app in the Mac's GUI (Aqua) session so
# the window appears on screen. Zero manual steps on the Mac: I run this, the app
# relaunches with the latest version of the branch under development.
#
# Nothing here is hardcoded to a specific machine, user, repo path, or Electron
# version — it auto-detects, and every default can be overridden by env:
#   MAC_HOST           ssh host/alias of the Mac        (default: mac)
#   LOOMBOX_MAC_REPO   loombox checkout path on the Mac (default: auto-detect)
#   PWA_URL            URL the app loads                (default: the app's own
#                      https://app.loombox.dev; set to e.g. http://localhost:5173
#                      to point at a dev server / preview)
#
# The desktop shell (Electron main/preload/window) comes from the branch; the UI
# it loads is the deployed PWA unless PWA_URL overrides it.
#
# Usage (from the devbox):
#   scripts/mac-desktop.sh                 # the branch we're on now (auto-published)
#   scripts/mac-desktop.sh some-branch     # a specific branch (must be on origin)
#   PWA_URL=http://localhost:5173 scripts/mac-desktop.sh
#
set -euo pipefail

# --- devbox side: pick the branch + make sure origin has its latest commit ----
SELF_REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CURRENT_BRANCH="$(git -C "$SELF_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
BRANCH="${1:-$CURRENT_BRANCH}"
MAC_HOST="${MAC_HOST:-mac}"
PWA_URL="${PWA_URL:-}"

if [ "$BRANCH" = "main" ]; then
  # main only ever advances through merged PRs — never push it from here, just
  # make sure our origin/main ref is current for the Mac to reset onto.
  git -C "$SELF_REPO" fetch origin main --quiet || true
elif [ "$BRANCH" = "$CURRENT_BRANCH" ]; then
  # The branch we're developing on: publish HEAD so the Mac pulls the latest.
  echo ">> publish $BRANCH -> origin"
  git -C "$SELF_REPO" push origin "HEAD:refs/heads/$BRANCH" --quiet
else
  # An explicit other branch: assume it's already on origin, just fetch it.
  git -C "$SELF_REPO" fetch origin "$BRANCH" --quiet
fi

echo ">> loombox desktop -> ${MAC_HOST} @ ${BRANCH}${PWA_URL:+  (PWA: ${PWA_URL})}"

# The remote flow runs as one heredoc'd script piped to the Mac's bash. Branch,
# PWA override and repo-path override go in as positional args so nothing needs
# escaping into the quoted body ('REMOTE' quoted => no local expansion).
# shellcheck disable=SC2087
ssh -o BatchMode=yes -o ConnectTimeout=25 "$MAC_HOST" 'bash -s' -- \
  "$BRANCH" "$PWA_URL" "${LOOMBOX_MAC_REPO:-}" <<'REMOTE'
set -euo pipefail
BRANCH="$1"
PWA_URL="${2:-}"
REPO="${3:-}"

# Auto-detect the checkout if not pinned via LOOMBOX_MAC_REPO.
if [ -z "$REPO" ]; then
  for c in "$HOME/Progetti/Personale/loombox" "$HOME/Progetti/loombox" "$HOME/loombox"; do
    [ -d "$c/.git" ] && REPO="$c" && break
  done
fi
[ -n "$REPO" ] || { echo "!! loombox checkout not found on the Mac; set LOOMBOX_MAC_REPO" >&2; exit 1; }

# nvm-installed toolchain: SSH non-interactive shells don't source nvm and the
# GUI session's PATH is barer still, so pin the newest installed node bin dir.
NODE_BIN="$(dirname "$(ls -1 "$HOME"/.nvm/versions/node/*/bin/pnpm 2>/dev/null | sort -V | tail -1)")"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"

cd "$REPO"
echo ">> fetch + hard-reset to origin/$BRANCH"
git fetch origin "$BRANCH" --quiet
git checkout "$BRANCH" --quiet 2>/dev/null || git checkout -b "$BRANCH" --track "origin/$BRANCH" --quiet
git reset --hard "origin/$BRANCH" --quiet
echo "   now at $(git rev-parse --short HEAD)"

echo ">> pnpm install"
pnpm install --silent

echo ">> stop any running loombox desktop dev instance"
# Every process the app spawns (Electron main + gpu/network/renderer helpers)
# carries THIS checkout's node_modules path in argv; a `pnpm ... dev` parent
# carries @loombox/desktop. Kill both, and nothing else — Docker's Electron and
# any other app live under different paths.
pkill -f "$REPO/node_modules/.*[Ee]lectron" 2>/dev/null || true
pkill -f "@loombox/desktop dev" 2>/dev/null || true
# Wait (up to ~5s) for them to actually exit so the relaunch is clean.
for _ in $(seq 1 10); do
  pgrep -f "$REPO/node_modules/.*[Ee]lectron" >/dev/null 2>&1 || break
  sleep 0.5
done

echo ">> launch in the GUI session"
# `launchctl asuser` needs root over SSH ("Operation not permitted"). `open`
# goes through LaunchServices, which targets the console user's Aqua session, so
# the window renders on screen without sudo. Launch the vendored Electron.app
# with the desktop app dir as its argv (== `electron .`).
EAPP="$(find "$REPO/node_modules/.pnpm" -maxdepth 6 -name Electron.app -type d 2>/dev/null | head -1)"
[ -n "$EAPP" ] || { echo "!! Electron.app not found — did pnpm install run?" >&2; exit 1; }
# Pass a PWA override through the GUI session's launchd env so the app inherits
# it; clear it otherwise so a stale value never lingers (app falls back to its
# built-in default).
if [ -n "$PWA_URL" ]; then
  launchctl setenv LOOMBOX_DESKTOP_PWA_URL "$PWA_URL" 2>/dev/null || true
else
  launchctl unsetenv LOOMBOX_DESKTOP_PWA_URL 2>/dev/null || true
fi
open -n -a "$EAPP" --args "$REPO/apps/desktop"
echo ">> launched"
REMOTE

echo ">> done"
