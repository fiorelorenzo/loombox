#!/usr/bin/env bash
#
# mac-desktop.sh — launch the loombox desktop app on Lorenzo's Mac, from the devbox.
#
# Run this FROM THE DEVBOX. It updates the loombox checkout on the Mac to the
# target branch, reinstalls deps, and (re)launches the Electron desktop app in
# the Mac's GUI (Aqua) session so the window appears on screen. Zero manual
# steps on the Mac: I run this, the app relaunches with the right version.
#
# The desktop shell (Electron main/preload/window) comes from the branch. The
# UI it loads is the deployed PWA (https://app.loombox.dev by default); override
# with LOOMBOX_DESKTOP_PWA_URL to point at a dev server or a preview instead.
#
# Usage (from the devbox):
#   scripts/mac-desktop.sh                 # branch main, deployed PWA
#   scripts/mac-desktop.sh some-branch     # a specific branch
#   PWA_URL=http://localhost:5173 scripts/mac-desktop.sh my-branch
#
set -euo pipefail

BRANCH="${1:-main}"
MAC_HOST="${MAC_HOST:-mac}"
PWA_URL="${PWA_URL:-}" # empty => the app's own default (https://app.loombox.dev)

echo ">> loombox desktop -> ${MAC_HOST} @ ${BRANCH}${PWA_URL:+  (PWA: ${PWA_URL})}"

# The whole remote flow runs as one heredoc'd script piped to the Mac's bash.
# The branch and PWA override are passed as positional args so nothing needs
# escaping into the quoted body ('REMOTE' is quoted => no local expansion).
# shellcheck disable=SC2087
ssh -o BatchMode=yes -o ConnectTimeout=25 "$MAC_HOST" 'bash -s' -- "$BRANCH" "$PWA_URL" <<'REMOTE'
set -euo pipefail
BRANCH="$1"
PWA_URL="${2:-}"

REPO="$HOME/Progetti/Personale/loombox"
# nvm-installed toolchain — SSH non-interactive shells don't source nvm, and
# launchctl's GUI session has an even barer PATH, so we pin it explicitly.
NODE_BIN="$(dirname "$(ls -1 "$HOME"/.nvm/versions/node/*/bin/pnpm 2>/dev/null | sort -V | tail -1)")"
export PATH="$NODE_BIN:$PATH"

cd "$REPO"
echo ">> fetch + hard-reset to origin/$BRANCH"
git fetch origin "$BRANCH" --quiet
git checkout "$BRANCH" --quiet 2>/dev/null || git checkout -b "$BRANCH" --track "origin/$BRANCH" --quiet
git reset --hard "origin/$BRANCH" --quiet
echo "   now at $(git rev-parse --short HEAD)"

echo ">> pnpm install"
pnpm install --silent

echo ">> stop any running loombox desktop instance"
# Match only THIS repo's Electron (path contains the checkout), never Docker's.
pkill -f "Progetti/Personale/loombox/.*[Ee]lectron" 2>/dev/null || true
sleep 1

echo ">> launch in the GUI session"
# `launchctl asuser` fails over SSH ("Operation not permitted" switching audit
# session) without root. `open` goes through LaunchServices, which targets the
# console user's Aqua session, so the window renders on screen — no sudo. We
# launch the vendored Electron.app directly with the desktop app dir as its
# argv (== `electron .`), the same thing `pnpm --filter @loombox/desktop dev`
# runs, minus the extra pnpm/tsx parent process.
EAPP="$(find "$REPO/node_modules/.pnpm" -maxdepth 6 -name Electron.app -type d 2>/dev/null | head -1)"
if [ -z "$EAPP" ]; then
  echo "!! Electron.app not found under node_modules/.pnpm — did pnpm install run?" >&2
  exit 1
fi
# An override PWA URL (dev server / preview) is passed through the user's
# launchd session env so the GUI-launched app inherits it; harmless no-op when
# unset (the app falls back to its built-in https://app.loombox.dev default).
if [ -n "$PWA_URL" ]; then
  launchctl setenv LOOMBOX_DESKTOP_PWA_URL "$PWA_URL" 2>/dev/null || true
else
  launchctl unsetenv LOOMBOX_DESKTOP_PWA_URL 2>/dev/null || true
fi
open -n -a "$EAPP" --args "$REPO/apps/desktop"
echo ">> launched"
REMOTE

echo ">> done"
