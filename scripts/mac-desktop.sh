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
#   MAC_HOST              ssh host/alias of the Mac        (default: mac)
#   LOOMBOX_MAC_REPO      loombox checkout path on the Mac (default: auto-detect)
#   PWA_URL               URL the app loads                (default: the app's own
#                         https://app.loombox.dev; in --debug, this box's dev server)
#   LOOMBOX_CDP_PORT      renderer CDP port                (default: 9222)
#   LOOMBOX_INSPECT_PORT  main-process inspector port      (default: 9229)
#   LOOMBOX_WEB_PORT      dev server port to point --debug at (default: 5173)
#
# The desktop shell (Electron main/preload/window) comes from the branch; the UI
# it loads is the deployed PWA unless PWA_URL overrides it.
#
# --debug adds the two argv flags that open the renderer's CDP endpoint and the
# main process's Node inspector, forwards both to this box, and points the app at
# this box's `vite dev` server (HMR: edit a file here, the Mac window updates).
# It is opt-in because CDP is arbitrary JS execution in the app's context, which
# includes the AMK in localStorage and every decrypted session. See AGENTS.md
# ("Debugging the desktop app on the Mac") for the full loop.
#
# Usage (from the devbox):
#   scripts/mac-desktop.sh                 # the branch we're on now (auto-published)
#   scripts/mac-desktop.sh some-branch     # a specific branch (must be on origin)
#   PWA_URL=http://localhost:5173 scripts/mac-desktop.sh
#   scripts/mac-desktop.sh --debug         # + CDP/inspector, pointed at our dev server
#   PWA_URL=https://app.loombox.dev scripts/mac-desktop.sh --debug   # debug prod bundle
set -euo pipefail

# --- devbox side: parse args, pick the branch, make sure origin has the commit -
SELF_REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CURRENT_BRANCH="$(git -C "$SELF_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
MAC_HOST="${MAC_HOST:-mac}"
PWA_URL="${PWA_URL:-}"
CDP_PORT="${LOOMBOX_CDP_PORT:-9222}"
INSPECT_PORT="${LOOMBOX_INSPECT_PORT:-9229}"
WEB_PORT="${LOOMBOX_WEB_PORT:-5173}"
DEBUG=0
RELOAD_ONLY=0
BRANCH=""

# Flags are positional-agnostic so any order reads naturally.
for arg in "$@"; do
  case "$arg" in
    --debug) DEBUG=1 ;;
    --reload) RELOAD_ONLY=1 ;;
    -*) echo "!! unknown flag: $arg" >&2; exit 2 ;;
    *) [ -z "$BRANCH" ] && BRANCH="$arg" ;;
  esac
done
BRANCH="${BRANCH:-$CURRENT_BRANCH}"

# `--reload` re-navigates the window of an ALREADY-running debug session and
# exits: no publish, no reset, no reinstall, no relaunch. Useful whenever the
# view is stale rather than the app broken - after a web deploy, or to force a
# fresh load without paying for a full relaunch.
if [ "$RELOAD_ONLY" = 1 ]; then
  command -v node >/dev/null 2>&1 || { echo "!! node not on PATH (needed for the CDP call)" >&2; exit 1; }
  curl -sf -o /dev/null --max-time 4 "http://127.0.0.1:${CDP_PORT}/json/version" || {
    echo "!! nothing answering CDP on ${CDP_PORT}; start a debug session first:" >&2
    echo "     $0 --debug" >&2
    exit 1
  }
  exec node "${SELF_REPO}/scripts/mac-desktop-cdp.mjs" "$CDP_PORT" navigate
fi

# Debug mode defaults the app at the devbox's own dev server (HMR: edit a file
# here, the Mac window updates) rather than the deployed PWA. An explicit
# PWA_URL always wins, so `PWA_URL=https://app.loombox.dev ... --debug` debugs
# the production bundle instead.
DEV_SERVER_URL=""
if [ "$DEBUG" = 1 ] && [ -z "$PWA_URL" ]; then
  command -v tailscale >/dev/null 2>&1 || {
    echo "!! tailscale CLI not found; the Mac reaches this box over the tailnet" >&2
    echo "   (set PWA_URL explicitly to skip dev-server autodetection)" >&2
    exit 1
  }
  DEV_HOST="$(tailscale ip -4 2>/dev/null | head -1)"
  [ -n "$DEV_HOST" ] || { echo "!! could not resolve this box's tailnet IP" >&2; exit 1; }
  DEV_SERVER_URL="http://${DEV_HOST}:${WEB_PORT}"
  PWA_URL="$DEV_SERVER_URL"

  # The dev server is long-lived, so this script never starts one (an
  # agent-spawned `vite dev` reparents to init and leaks the port for days —
  # see the janitor notes in the shared agent docs). Fail loud with the exact
  # command instead. Bind the tailnet IP, never 0.0.0.0: this is a public VPS,
  # and UFW's tailscale0 allow is not a reason to also listen on the public one.
  if ! curl -sf -o /dev/null --max-time 4 "$DEV_SERVER_URL"; then
    echo "!! no dev server answering on ${DEV_SERVER_URL}" >&2
    echo "   start one first (it must bind the tailnet IP so the Mac can reach it):" >&2
    echo "     pnpm --filter @loombox/web exec vite dev --host ${DEV_HOST}" >&2
    echo "   or debug the deployed bundle instead:" >&2
    echo "     PWA_URL=https://app.loombox.dev $0 ${BRANCH} --debug" >&2
    exit 1
  fi
  echo ">> dev server reachable at ${DEV_SERVER_URL} (HMR loop)"
fi

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

BANNER=">> loombox desktop -> ${MAC_HOST} @ ${BRANCH}${PWA_URL:+  (PWA: ${PWA_URL})}"
[ "$DEBUG" = 1 ] && BANNER="$BANNER  [debug]"
echo "$BANNER"

# Debug mode is argv flags, nothing more: the renderer's CDP endpoint and the
# main process's Node inspector. Both bind loopback on the Mac and are opt-in
# because CDP is arbitrary JS in the app's context, which means the AMK in
# localStorage and every decrypted session.
DEBUG_ARGS=""
SECURE_ORIGIN=""
if [ "$DEBUG" = 1 ]; then
  DEBUG_ARGS="--remote-debugging-port=${CDP_PORT} --inspect=${INSPECT_PORT}"

  # A plain-http dev origin is NOT a secure context, and that is fatal rather
  # than cosmetic here: no `crypto.subtle`, so the app cannot generate or unwrap
  # an AMK and the entire session view stays unreachable behind onboarding.
  # (Verified on the real window: `isSecureContext: false`, `crypto.subtle`
  # undefined on http://<tailnet-ip>:5173.) Chromium grants one named origin the
  # secure treatment, but only alongside its own profile dir, so the remote side
  # pairs this with `--user-data-dir` once it knows the Mac's $HOME.
  case "$PWA_URL" in
    http://*) SECURE_ORIGIN="$PWA_URL" ;;
  esac
fi

# The remote flow runs as one heredoc'd script piped to the Mac's bash. Branch,
# PWA override, repo-path override and the debug flags go in as positional args
# so nothing needs escaping into the quoted body ('REMOTE' quoted => no local
# expansion).
#
# `printf %q` is load-bearing, not cosmetic: ssh joins its command words into ONE
# string for the remote shell, so an unquoted empty argument (no LOOMBOX_MAC_REPO,
# say) simply vanishes and every later argument shifts down a slot - which is how
# the debug flags first landed in $3 and made the remote `cd` to `--`. Quoting
# each value keeps empties as real empty arguments, and keeps the two debug flags
# a single $4 that only `open` word-splits.
REMOTE_ARGV="$(printf '%q ' "$BRANCH" "$PWA_URL" "${LOOMBOX_MAC_REPO:-}" "$DEBUG_ARGS" "$SECURE_ORIGIN")"
# shellcheck disable=SC2087
ssh -o BatchMode=yes -o ConnectTimeout=25 "$MAC_HOST" "bash -s -- $REMOTE_ARGV" <<'REMOTE'
set -euo pipefail
BRANCH="$1"
PWA_URL="${2:-}"
REPO="${3:-}"
DEBUG_ARGS="${4:-}"
SECURE_ORIGIN="${5:-}"

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
# Pass the PWA override as an app argv flag, NOT through `launchctl setenv`:
# the launchd user domain accepts the value (and `launchctl getenv` reads it
# straight back), but a LaunchServices-started app on macOS 26 does not inherit
# it, so the env route silently loaded production instead. `open --args` does
# reach the app. Also clear any value a previous version of this script left in
# the launchd domain, so a stale export can never win over an explicit launch.
launchctl unsetenv LOOMBOX_DESKTOP_PWA_URL 2>/dev/null || true
APP_ARGS=""
[ -n "$PWA_URL" ] && APP_ARGS="--pwa-url=$PWA_URL"
# Pair the named-origin exemption with its own profile dir, which Chromium
# requires for it to take effect. A stable path (and one with NO spaces, since
# these flags are deliberately word-split below) so the dev origin's session and
# AMK persist between debug launches without touching the normal profile.
if [ -n "$SECURE_ORIGIN" ]; then
  DEBUG_ARGS="$DEBUG_ARGS --unsafely-treat-insecure-origin-as-secure=$SECURE_ORIGIN"
  DEBUG_ARGS="$DEBUG_ARGS --user-data-dir=$HOME/.loombox-desktop-debug"
fi
# Word-splitting is the point for both: each is either empty or whole flags.
# shellcheck disable=SC2086
open -n -a "$EAPP" --args "$REPO/apps/desktop" $APP_ARGS $DEBUG_ARGS
echo ">> launched${APP_ARGS:+ $APP_ARGS}${DEBUG_ARGS:+ $DEBUG_ARGS}"
REMOTE

if [ "$DEBUG" = 1 ]; then
  # Forward each debug port to THE SAME local port number, never a remapped one:
  # CDP's /json/list hands back a `webSocketDebuggerUrl` of
  # ws://127.0.0.1:<remote-port>/..., and every client uses that verbatim, so a
  # 9333->9222 forward yields URLs that point at nothing on this side.
  forward() {
    local port="$1" name="$2"
    local args="-f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L ${port}:127.0.0.1:${port}"

    # Already answering through an existing forward? Reuse it.
    if curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:${port}/json/version"; then
      echo "   ${name}: reusing forward on ${port}"
      return 0
    fi
    # A listener that does NOT answer CDP is a stale forward from a previous
    # app instance; drop it so the fresh one can bind.
    pkill -f "ssh $args $MAC_HOST" 2>/dev/null || true
    # Word-splitting `args` is intended: they are separate ssh options.
    # shellcheck disable=SC2086
    ssh $args "$MAC_HOST" || {
      echo "   !! ${name}: could not forward ${port}" >&2
      return 1
    }
    for _ in $(seq 1 20); do
      curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${port}/json/version" && return 0
      sleep 0.5
    done
    echo "   !! ${name}: forwarded ${port} but nothing answered CDP there" >&2
    return 1
  }

  echo ">> forwarding debug ports from ${MAC_HOST}"
  forward "$CDP_PORT" "renderer" || true
  forward "$INSPECT_PORT" "main process" || true

  # Confirm the window actually rendered the app rather than reporting "launched"
  # and leaving a stale 500 on screen (the window's first request races vite's
  # cold SSR compile often enough that this is the normal case, not the rare one).
  if command -v node >/dev/null 2>&1 &&
    curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:${CDP_PORT}/json/version"; then
    node "${SELF_REPO}/scripts/mac-desktop-cdp.mjs" "$CDP_PORT" settle "$PWA_URL" || true
  fi

  cat <<HINTS

   renderer  (DOM, console, network, screenshots)
     http://127.0.0.1:${CDP_PORT}          curl -s localhost:${CDP_PORT}/json/list
   main process  (Electron/Node inspector)
     http://127.0.0.1:${INSPECT_PORT}          curl -s localhost:${INSPECT_PORT}/json/list
   stop forwarding
     pkill -f 'ssh -f -N .* -L ${CDP_PORT}:127.0.0.1:${CDP_PORT}'
HINTS
fi

echo ">> done"
