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
# --dev makes this the only command a dev session needs: it brings the local loop
# up on THIS box first (postgres + relay + node daemon + web, against the dev
# GitHub OAuth app), launches the app pointed at it, and ties the two ends
# together. Quit the app on the Mac and the loop stops here; Ctrl+C here and the
# app quits there. Nothing is left running on either side either way.
#
# Nothing here is hardcoded to a specific machine, user, repo path, or Electron
# version — it auto-detects, and every default can be overridden by env:
#   MAC_HOST              ssh host/alias of the Mac        (default: mac)
#   LOOMBOX_MAC_REPO      loombox checkout path on the Mac (default: auto-detect)
#   PWA_URL               URL the app loads                (default: the app's own
#                         https://app.loombox.dev; --hmr points it at this box)
#   LOOMBOX_CDP_PORT      renderer CDP port                (default: 9222)
#   LOOMBOX_INSPECT_PORT  main-process inspector port      (default: 9229)
#
# The desktop shell (Electron main/preload/window) comes from the branch; the UI
# it loads is the deployed PWA unless --hmr or PWA_URL overrides it.
#
# --hmr loads THIS box's `vite dev` server instead, so editing a file here updates
# the Mac window in place. The window reaches it as http://localhost:5173, through
# the reverse SSH forwards `scripts/dev.sh` opens (this script re-opens them if the
# Mac cannot reach the port), never as http://<tailnet-ip>:5173 — and that is not a
# nicety, the whole local loop is localhost-shaped: `localhost` is a secure context
# per spec, so `crypto.subtle` exists and the app can unwrap its AMK; the dev relay
# only sends `Access-Control-Allow-Origin` for http://localhost:5173; the app dials
# ws://localhost:8790/ws; and the GitHub OAuth App's callback is registered on
# localhost:8790. The tunnel carries 8790 too, so all four hold on the Mac.
#
# --debug adds the two argv flags that open the renderer's CDP endpoint and the
# main process's Node inspector, and forwards both to this box. It implies --hmr
# unless PWA_URL says otherwise. It is opt-in because CDP is arbitrary JS execution
# in the app's context, which includes the AMK in localStorage and every decrypted
# session. See AGENTS.md ("Debugging the desktop app on the Mac") for the full loop.
#
# Usage (from the devbox):
#   scripts/mac-desktop.sh                 # the branch we're on now (auto-published)
#   scripts/mac-desktop.sh some-branch     # a specific branch (must be on origin)
#   scripts/mac-desktop.sh --hmr           # + live-reload against this box's dev loop
#   scripts/mac-desktop.sh --debug         # + CDP/inspector (implies --hmr)
#   scripts/mac-desktop.sh --dev           # + bring the local loop up/down with it
#   scripts/mac-desktop.sh --dev --fresh   # + wipe the dev database on the way up
#   PWA_URL=https://app.loombox.dev scripts/mac-desktop.sh --debug   # debug prod bundle
set -euo pipefail

# mise is not loaded in non-interactive shells on the dev box, and the CDP steps
# below shell out to `node` — same guard as scripts/dev.sh and scripts/run-relay.sh.
# Without it, --debug silently skips the check that the window actually rendered.
if [ -x "$HOME/.local/bin/mise" ]; then
  eval "$("$HOME/.local/bin/mise" activate bash)"
fi

# --- devbox side: parse args, pick the branch, make sure origin has the commit -
SELF_REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CURRENT_BRANCH="$(git -C "$SELF_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
MAC_HOST="${MAC_HOST:-mac}"
PWA_URL="${PWA_URL:-}"
CDP_PORT="${LOOMBOX_CDP_PORT:-9222}"
INSPECT_PORT="${LOOMBOX_INSPECT_PORT:-9229}"
# Fixed, not env-overridable, exactly as in scripts/dev.sh: the GitHub OAuth App's
# callback URL and the relay's LOOMBOX_TRUSTED_ORIGINS are registered against these
# exact ports, so a "just use another port" override would silently break login on
# the Mac too.
readonly WEB_PORT=5173
readonly RELAY_PORT=8790
# Must stay byte-identical to scripts/dev.sh's MAC_FWD_ARGS: both scripts replace a
# stale tunnel with `pkill -f "ssh $MAC_FWD_ARGS $MAC_HOST"`, so a single differing
# flag would leave each unable to clear the other's forward — and the fresh -R would
# then fail with the remote port already bound.
readonly MAC_FWD_ARGS="-f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -R ${WEB_PORT}:127.0.0.1:${WEB_PORT} -R ${RELAY_PORT}:127.0.0.1:${RELAY_PORT}"
DEBUG=0
HMR=0
RELOAD_ONLY=0
DEV=0
FRESH=0
BRANCH=""

# Flags are positional-agnostic so any order reads naturally.
for arg in "$@"; do
  case "$arg" in
    --debug) DEBUG=1 ;;
    --reload) RELOAD_ONLY=1 ;;
    --hmr) HMR=1 ;;
    --dev) DEV=1 ;;
    --fresh) FRESH=1 ;;
    -*) echo "!! unknown flag: $arg" >&2; exit 2 ;;
    *) [ -z "$BRANCH" ] && BRANCH="$arg" ;;
  esac
done
BRANCH="${BRANCH:-$CURRENT_BRANCH}"

# --debug's whole point was iterating on the app, and it has always defaulted to
# this box's dev server rather than the deployed bundle. That stays true now that
# the HMR route is its own flag: --debug implies --hmr unless PWA_URL says
# otherwise, and --hmr alone gives the live-reload loop without opening CDP.
if [ "$DEBUG" = 1 ] && [ -z "$PWA_URL" ]; then
  HMR=1
fi

# --dev owns the loop the window talks to, so it always wants the local dev
# server. PWA_URL still wins for the URL itself, exactly as it does for --hmr.
if [ "$DEV" = 1 ]; then
  HMR=1
fi

# --fresh is scripts/dev.sh's flag, forwarded. Alone it would silently do
# nothing, which is the kind of quiet no-op that costs an hour when the database
# you meant to wipe is still sitting there.
if [ "$FRESH" = 1 ] && [ "$DEV" = 0 ]; then
  echo "!! --fresh only means something with --dev (it wipes the loop's Postgres)" >&2
  exit 2
fi

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

# --hmr points the app at this box's dev server, reached as http://localhost:<web
# port> through the reverse SSH forwards (see the header for why localhost and not
# the tailnet IP). An explicit PWA_URL always wins, so
# `PWA_URL=https://app.loombox.dev ... --debug` debugs the production bundle.
if [ "$HMR" = 1 ] && [ -z "$PWA_URL" ]; then
  PWA_URL="http://localhost:${WEB_PORT}"
fi

# The two things --dev owns past the command that started them: the loop running
# here, and the ssh session that stands in for the app on the Mac (run_remote
# below). Empty means "not ours", which is how a reused loop survives.
LOOP_PID=""
WATCH_PID=""

# Brings both ends down together — on Ctrl+C, on an early `exit 1` below, or when
# the watcher notices the app is gone. Self-disarming, and it re-exits with the
# code it found, the same shape as scripts/dev.sh's own cleanup.
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [ -n "$WATCH_PID" ]; then
    echo ">> quitting the desktop app on ${MAC_HOST}"
    # Drop the watcher first so it cannot race the stop, then say so explicitly
    # over a second connection. Hanging up is NOT enough on its own: without a
    # PTY, sshd sends the remote side no SIGHUP, so the watcher we just killed was
    # measured still polling minutes later, reparented to init, with the window
    # still on screen. The remote HUP trap stays as a backstop for the paths that
    # do signal (and it is what makes a dropped tunnel quit the app too).
    kill "$WATCH_PID" 2>/dev/null || true
    wait "$WATCH_PID" 2>/dev/null || true
    WATCH_PID=""
    run_remote stop || echo "   !! could not reach ${MAC_HOST} to stop the app" >&2
  fi
  # This launch's own debug forwards, which nothing else reaps while --dev owns
  # the session (a later launch without --debug would, eventually).
  if [ "$DEBUG" = 1 ] && declare -F debug_fwd_args >/dev/null; then
    for p in "$CDP_PORT" "$INSPECT_PORT"; do
      pkill -f "ssh $(debug_fwd_args "$p") $MAC_HOST" 2>/dev/null || true
    done
  fi
  if [ -n "$LOOP_PID" ] && kill -0 "$LOOP_PID" 2>/dev/null; then
    echo ">> stopping the dev loop"
    # TERM, never INT: a command started in the background by a script has
    # SIGINT ignored on entry, and a shell cannot trap a signal that was already
    # ignored when it started — so dev.sh's `trap cleanup INT` would never run
    # and every process it started would leak. TERM is trapped there normally.
    kill "$LOOP_PID" 2>/dev/null || true
    for _ in $(seq 1 60); do
      kill -0 "$LOOP_PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$LOOP_PID" 2>/dev/null; then
      kill -9 "$LOOP_PID" 2>/dev/null || true
      echo "   !! it did not stop on its own; if a port is still held:" >&2
      echo "      scripts/dev.sh --stop" >&2
    fi
  fi
  exit "$code"
}

# The loop's two HTTP ends. Both matter: the window loads the web port, the app
# dials the relay. /health also identifies a loombox relay rather than whatever
# else might be sitting on the port, which is what makes `loop_starting` below a
# safe thing to adopt.
loop_answers() {
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${RELAY_PORT}/health" &&
    curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${WEB_PORT}"
}
loop_starting() {
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${RELAY_PORT}/health" ||
    curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${WEB_PORT}"
}

# Brings up the loop this box serves, or adopts one that is already running — a
# `scripts/dev.sh` in another terminal is someone else's to stop, so it is
# reused and deliberately left alone on the way out.
ensure_dev_loop() {
  # Either end answering means a loop is already there, including one still
  # coming up: the relay binds a beat before vite does, and asking only about the
  # web port loses that race. Measured: by ~700ms, which was enough to start a
  # second loop that then refused itself on the busy ports and took the launch
  # down with it. Anything that is NOT a loombox relay fails /health, so a plain
  # squatter still ends up on the start path below, where dev.sh's own preflight
  # names it.
  if loop_starting; then
    echo ">> reusing the loop already up (not ours to stop)"
    for _ in $(seq 1 60); do
      loop_answers && return 0
      sleep 1
    done
    echo "!! that loop never finished coming up (relay ${RELAY_PORT}, web ${WEB_PORT})" >&2
    exit 1
  fi
  local args=()
  [ "$FRESH" = 1 ] && args+=(--fresh)
  echo ">> starting the dev loop here (postgres + relay + node + web)"
  "$SELF_REPO/scripts/dev.sh" "${args[@]}" &
  LOOP_PID=$!
  # A cold Postgres volume can take ~30s, so be patient — but notice a loop that
  # died (missing credentials, a squatted port) instead of waiting out the limit.
  for _ in $(seq 1 120); do
    if ! kill -0 "$LOOP_PID" 2>/dev/null; then
      LOOP_PID=""
      echo "!! the loop exited while starting — its own output above says why" >&2
      exit 1
    fi
    if loop_answers; then
      # Our own child has to still be running: an answer alone can come from a
      # loop that was already there, while ours is in its port preflight about to
      # refuse. A second is all that takes.
      sleep 1
      if ! kill -0 "$LOOP_PID" 2>/dev/null; then
        LOOP_PID=""
        echo "!! the loop we started exited immediately — its output above says why" >&2
        exit 1
      fi
      echo "   up: relay ${RELAY_PORT}, web ${WEB_PORT}"
      return 0
    fi
    sleep 1
  done
  echo "!! the loop did not answer within 120s" >&2
  exit 1
}

# From here on --dev has something to tear down on every exit path.
if [ "$DEV" = 1 ]; then
  trap cleanup EXIT INT TERM
fi

if [ "$HMR" = 1 ]; then
  # A sleeping laptop is the common case, and it has to be told apart from a
  # busy port before either probe below runs: `MAC_FWD_ARGS` deliberately
  # carries no `ConnectTimeout` (it must stay byte-identical to dev.sh's), so
  # an unreachable host makes the forward hang on the TCP timeout and then
  # report "something may already hold that port", which is simply wrong.
  # Measured: 280s to the wrong diagnosis. Same probe dev.sh uses. It runs
  # before --dev starts anything, so no loop is ever brought up here for a
  # window that cannot appear over there.
  if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$MAC_HOST" true 2>/dev/null; then
    echo "!! ${MAC_HOST} is not reachable over ssh - asleep, or off the tailnet?" >&2
    echo "   --hmr needs it: the window loads http://localhost:${WEB_PORT} on the Mac," >&2
    echo "   which only resolves through a reverse forward back to this box." >&2
    echo "   Wake it, or drop --hmr to run against the deployed bundle:" >&2
    echo "     $0 ${BRANCH}" >&2
    exit 1
  fi

  if [ "$DEV" = 1 ]; then
    ensure_dev_loop
  elif ! curl -sf -o /dev/null --max-time 4 "http://127.0.0.1:${WEB_PORT}"; then
    # Without --dev this script starts no loop: a long-lived `vite dev` spawned
    # from a one-shot command reparents to init and leaks the port for days (see
    # the janitor notes in the shared agent docs). --dev is the opt-in that also
    # takes responsibility for stopping what it started.
    echo "!! no dev server answering on http://127.0.0.1:${WEB_PORT}" >&2
    echo "   let this command own the loop too:" >&2
    echo "     $0 --dev" >&2
    echo "   or bring it up yourself first (relay + node + web):" >&2
    echo "     scripts/dev.sh" >&2
    echo "   or run against the deployed bundle instead (drop --hmr):" >&2
    echo "     $0 ${BRANCH}" >&2
    exit 1
  fi

  # `scripts/dev.sh` opens these forwards, but only best-effort: it skips them when
  # the Mac is unreachable at loop start, and a laptop that slept since takes the
  # tunnel down with it. Ask the Mac, the only side that can tell, and re-open
  # rather than pointing a window at a dead port.
  mac_reaches_dev_server() {
    # shellcheck disable=SC2029  # ${WEB_PORT} is meant to expand here, client-side
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$MAC_HOST" \
      "curl -sf -o /dev/null --max-time 5 http://localhost:${WEB_PORT}" 2>/dev/null
  }
  if mac_reaches_dev_server; then
    echo ">> ${MAC_HOST} already reaches this box's dev server on localhost:${WEB_PORT}"
  else
    echo ">> opening reverse forwards to ${MAC_HOST} (its localhost -> this loop)"
    pkill -f -- "ssh $MAC_FWD_ARGS $MAC_HOST" 2>/dev/null || true
    # shellcheck disable=SC2086  # a fixed set of ssh flags; word-splitting is the point
    # shellcheck disable=SC2029  # $MAC_HOST is ssh's destination, not a remote command: -N runs none
    if ! ssh $MAC_FWD_ARGS "$MAC_HOST"; then
      echo "!! could not forward ${WEB_PORT}/${RELAY_PORT} to ${MAC_HOST}" >&2
      echo "   something on the Mac may already hold one of them" >&2
      exit 1
    fi
    if ! mac_reaches_dev_server; then
      echo "!! forwarded, but the Mac still cannot reach localhost:${WEB_PORT}" >&2
      exit 1
    fi
    echo "   done - that origin is a real secure context on the Mac, no flags needed"
  fi
fi

if [ "$BRANCH" = "main" ]; then
  # main only ever advances through merged PRs — never push it from here, just
  # make sure our origin/main ref is current for the Mac to reset onto.
  git -C "$SELF_REPO" fetch origin main --quiet || true
elif [ "$BRANCH" = "$CURRENT_BRANCH" ]; then
  # The branch we're developing on: publish HEAD so the Mac pulls the latest.
  # --force-with-lease because amending a WIP commit is ordinary work on a branch
  # like this, and a plain push then fails with "non-fast-forward" and takes the
  # whole launch down with it. The lease is what keeps that safe: it refuses if
  # origin moved somewhere we have not seen, so a plain force's "clobber whatever
  # is there" is exactly what it will not do. main never reaches this branch.
  echo ">> publish $BRANCH -> origin"
  git -C "$SELF_REPO" push --force-with-lease origin "HEAD:refs/heads/$BRANCH" --quiet
else
  # An explicit other branch: assume it's already on origin, just fetch it.
  git -C "$SELF_REPO" fetch origin "$BRANCH" --quiet
fi

BANNER=">> loombox desktop -> ${MAC_HOST} @ ${BRANCH}${PWA_URL:+  (PWA: ${PWA_URL})}"
[ "$HMR" = 1 ] && BANNER="$BANNER  [hmr]"
[ "$DEBUG" = 1 ] && BANNER="$BANNER  [debug]"
echo "$BANNER"

# Debug mode is argv flags, nothing more: the renderer's CDP endpoint and the
# main process's Node inspector. Both bind loopback on the Mac and are opt-in
# because CDP is arbitrary JS in the app's context, which means the AMK in
# localStorage and every decrypted session.
DEBUG_ARGS=""
if [ "$DEBUG" = 1 ]; then
  DEBUG_ARGS="--remote-debugging-port=${CDP_PORT} --inspect=${INSPECT_PORT}"
fi

# A plain-http origin that is NOT localhost is not a secure context, and that is
# fatal rather than cosmetic here: no `crypto.subtle`, so the app cannot generate or
# unwrap an AMK and the whole session view stays unreachable behind onboarding.
# (Verified on the real window: `isSecureContext: false`, `crypto.subtle` undefined
# on http://<tailnet-ip>:5173.) Chromium grants one named origin the secure
# treatment, but only alongside its own profile dir, so the remote side pairs this
# with `--user-data-dir` once it knows the Mac's $HOME.
#
# --hmr never comes through here: it reaches this box as http://localhost:<web port>
# through the reverse forwards, and localhost is secure by spec. This is the one
# other route that needs it — pointing the window at http://<tailnet-ip>:5173 to
# iterate against the PRODUCTION relay, whose LOOMBOX_TRUSTED_ORIGINS carries that
# exact origin (the dev relay only ever trusts http://localhost:<web port>).
SECURE_ORIGIN=""
case "$PWA_URL" in
  http://localhost:* | http://127.0.0.1:*) ;;
  http://*) SECURE_ORIGIN="$PWA_URL" ;;
esac

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

# One ssh invocation and one remote body, run in two modes: `launch` does the
# publish/reset/install/launch flow, `stop` only stops the app. Teardown needs
# that second mode because every fact about the Mac's checkout - where it is, how
# its processes are matched, how they are stopped - is resolved over there, and
# duplicating any of it here is how the two sides drift apart.
#
# Called in the foreground normally and in the background for --dev, where the
# launch session doubles as the app's watchdog (see the tail of the body).
# Keepalives only matter for that long-lived case: a laptop that sleeps mid-session
# would otherwise leave this hanging on a dead socket, with the loop it started
# running for nobody.
SSH_LAUNCH_OPTS=(-o BatchMode=yes -o ConnectTimeout=25)
[ "$DEV" = 1 ] && SSH_LAUNCH_OPTS+=(-o ServerAliveInterval=15 -o ServerAliveCountMax=4)

run_remote() {
  local argv
  argv="$(printf '%q ' "$BRANCH" "$PWA_URL" "${LOOMBOX_MAC_REPO:-}" "$DEBUG_ARGS" "$SECURE_ORIGIN" "$DEV" "$1")"
  # shellcheck disable=SC2087  # $argv is built with printf %q on purpose:
  # shellcheck disable=SC2029  # it must expand HERE, client-side, into the argv
  ssh "${SSH_LAUNCH_OPTS[@]}" "$MAC_HOST" "bash -s -- $argv" <<'REMOTE'
set -euo pipefail
BRANCH="$1"
PWA_URL="${2:-}"
REPO="${3:-}"
DEBUG_ARGS="${4:-}"
SECURE_ORIGIN="${5:-}"
WATCH="${6:-0}"
MODE="${7:-launch}"

# Auto-detect the checkout if not pinned via LOOMBOX_MAC_REPO. Any directory
# named loombox holding a git checkout, at $HOME or up to two levels below it,
# rather than a list of one person's own folder names. This body runs under
# `bash -s`, where a pattern that matches nothing stays literal and simply fails
# the -d test below (the login shell here is zsh, which would abort on it, and
# `nullglob` is not the fix: it would also empty the `ls .nvm/...` glob further
# down, leaving `ls` to list the wrong directory).
if [ -z "$REPO" ]; then
  for c in "$HOME"/loombox "$HOME"/*/loombox "$HOME"/*/*/loombox; do
    [ -d "$c/.git" ] && REPO="$c" && break
  done
fi
[ -n "$REPO" ] || { echo "!! loombox checkout not found on the Mac; set LOOMBOX_MAC_REPO" >&2; exit 1; }

# Which processes are "the app". The main one's argv is `.../MacOS/Electron <app
# dir> [flags]`, and only there does the app directory follow the executable
# directly: a renderer helper carries it as `--app-path=` further along, so the
# adjacency here is what tells the two apart (measured: 1 match for the main
# pattern, 2 for a looser `Electron .*apps/desktop`). It matters because Chromium
# restarts helpers, so signalling one of those is not stopping anything — measured
# again: a broad `pkill -f` over the checkout reaped a helper, the main stayed up
# with a fresh pair, and the window was still on screen. Act on the main; the wide
# pattern is only for sweeping leftovers.
APP_MAIN_PATTERN="$REPO/node_modules/.*MacOS/Electron $REPO/apps/desktop"
APP_ANY_PATTERN="$REPO/node_modules/.*[Ee]lectron"

# Watchers left over from a session whose ssh died without signalling them (no
# PTY, no SIGHUP - see the dev box's cleanup). They cannot stop anything anymore,
# but they do keep polling, and a fresh app makes them latch onto that one instead
# of exiting. PPID 1 is what tells an orphan apart from the live watcher, whose
# parent is still its sshd.
reap_orphan_watchers() {
  pkill -P 1 -f 'bash -s -- ' 2>/dev/null || true
}

# Stops this checkout's app and nothing else (Docker's Electron and every other
# app live under different paths). TERM first, since that is what the main process
# actually honours, then verify — reporting "stopped" without checking is how two
# instances end up on screen at once.
stop_app() {
  local pids
  pids="$(pgrep -f "$APP_MAIN_PATTERN" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086  # a pid list: word splitting is the point
    kill -TERM $pids 2>/dev/null || true
    for _ in $(seq 1 20); do
      pgrep -f "$APP_MAIN_PATTERN" >/dev/null 2>&1 || break
      sleep 0.5
    done
    if pgrep -f "$APP_MAIN_PATTERN" >/dev/null 2>&1; then
      echo "   it ignored TERM after 10s - killing it"
      pkill -9 -f "$APP_MAIN_PATTERN" 2>/dev/null || true
    fi
  fi
  # Helpers exit with their main, but sweep any that outlived it so the next
  # launch's own liveness checks are not reading a leftover as a running app.
  pkill -f "$APP_ANY_PATTERN" 2>/dev/null || true
}

# `stop` mode ends here: no toolchain, no git, no launch — just put this
# checkout's app down. It is what the dev box's teardown calls, and also a
# perfectly good "close it for me" on its own.
if [ "$MODE" = stop ]; then
  stop_app
  reap_orphan_watchers
  if pgrep -f "$APP_MAIN_PATTERN" >/dev/null 2>&1; then
    echo "!! the app is still running after a stop" >&2
    exit 1
  fi
  echo ">> the desktop app is stopped"
  exit 0
fi

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
# A `pnpm ... dev` parent carries @loombox/desktop rather than the Electron path.
pkill -f "@loombox/desktop dev" 2>/dev/null || true
stop_app
# Before a fresh app exists for them to latch onto.
reap_orphan_watchers
if pgrep -f "$APP_MAIN_PATTERN" >/dev/null 2>&1; then
  echo "!! the running instance would not stop; launching now would leave two" >&2
  exit 1
fi

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
#
# Redirecting to /dev/null is what keeps this from hanging: the launched app
# inherits these descriptors, and ssh does not close the session while anything
# still holds its stdout - so without this, the whole script blocks after
# printing "launched" until the app itself exits (observed: a 15-minute hang).
# shellcheck disable=SC2086
open -n -a "$EAPP" --args "$REPO/apps/desktop" $APP_ARGS $DEBUG_ARGS >/dev/null 2>&1
echo ">> launched${APP_ARGS:+ $APP_ARGS}${DEBUG_ARGS:+ $DEBUG_ARGS}"

# --dev: this session becomes the app's watchdog, in both directions. `open`
# detaches the app, so nothing else ties its life to the dev box: we block while
# it runs (so the far end can stop the loop when it quits), and if the session
# goes away first the trap quits the app rather than leaving a window pointed at
# a loop that is already stopping. Both use `stop_app`/`APP_MAIN_PATTERN` from the
# top of this body, so watching, quitting and relaunching all mean the same
# process — and it all stays here, on the side where $REPO was resolved.
if [ "$WATCH" = 1 ]; then
  trap 'echo; echo ">> the dev box hung up - quitting the app"; stop_app; exit 0' HUP INT TERM
  # Appearing takes a moment: do not read "not up yet" as "already gone".
  for _ in $(seq 1 60); do
    pgrep -f "$APP_MAIN_PATTERN" >/dev/null 2>&1 && break
    sleep 0.5
  done
  echo ">> watching the app - quit it here and the dev loop stops on the dev box"
  while pgrep -f "$APP_MAIN_PATTERN" >/dev/null 2>&1; do
    sleep 3
  done
  echo ">> the desktop app exited"
fi
REMOTE
}

if [ "$DEV" = 1 ]; then
  run_remote launch &
  WATCH_PID=$!
else
  run_remote launch
fi

# The exact ssh options a debug forward is opened with. Shared, because the
# non-debug branch below has to `pkill` precisely what the debug branch created:
# a launch without `--debug` used to leave the previous run's two forwards alive,
# pointing at an app that no longer exposes CDP, and this box's own janitor is
# there because leaked port-holders are a real nuisance here.
debug_fwd_args() {
  echo "-f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L ${1}:127.0.0.1:${1}"
}

if [ "$DEBUG" = 1 ]; then
  # Forward each debug port to THE SAME local port number, never a remapped one:
  # CDP's /json/list hands back a `webSocketDebuggerUrl` of
  # ws://127.0.0.1:<remote-port>/..., and every client uses that verbatim, so a
  # 9333->9222 forward yields URLs that point at nothing on this side.
  forward() {
    local port="$1" name="$2"
    local args
    args="$(debug_fwd_args "$port")"

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
    # shellcheck disable=SC2029  # $MAC_HOST is ssh's destination, not a remote command: -N runs none
    ssh $args "$MAC_HOST" || {
      echo "   !! ${name}: could not forward ${port}" >&2
      return 1
    }
    # --dev launched in the background and the remote side still has a fetch, an
    # install and the app's own startup ahead of it, so CDP appears much later
    # than in a foreground launch. Same forward, more patience.
    local tries=20
    [ "$DEV" = 1 ] && tries=180
    for _ in $(seq 1 "$tries"); do
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
else
  # This launch exposes no CDP, so any forward still standing from an earlier
  # `--debug` run now points at nothing. Reap both rather than leaving two dead
  # listeners on 9222/9229 for the next reader to wonder about.
  for p in "$CDP_PORT" "$INSPECT_PORT"; do
    # shellcheck disable=SC2029  # $MAC_HOST is ssh's destination, not a remote command
    if pkill -f "ssh $(debug_fwd_args "$p") $MAC_HOST" 2>/dev/null; then
      echo ">> dropped a stale debug forward on ${p} (this launch has no CDP)"
    fi
  done
fi

if [ "$HMR" = 1 ]; then
  cat <<HINTS
   HMR: edit apps/web on this box and the Mac window updates in place
     dev origin       ${PWA_URL}  (secure context, no Chromium flags)
     stop forwarding  pkill -f 'ssh .* -R ${WEB_PORT}:127.0.0.1:${WEB_PORT}'
HINTS
fi

# --dev holds the terminal for as long as the session lasts: this is the wait
# that makes one command enough. Whichever end goes first ends it, and the EXIT
# trap takes the other one down.
if [ "$DEV" = 1 ]; then
  cat <<HINTS

   this command owns the session now
     quit the app on ${MAC_HOST}   -> the loop stops here
     Ctrl+C here                   -> the app quits there
${LOOP_PID:+     postgres keeps its data between runs (scripts/dev.sh --stop to drop it)}
HINTS
  while :; do
    if ! kill -0 "$WATCH_PID" 2>/dev/null; then
      WATCH_PID=""
      echo
      echo ">> the app on ${MAC_HOST} is gone"
      break
    fi
    if [ -n "$LOOP_PID" ] && ! kill -0 "$LOOP_PID" 2>/dev/null; then
      LOOP_PID=""
      echo
      echo "!! the dev loop stopped on its own - see its output above" >&2
      break
    fi
    sleep 2
  done
fi

echo ">> done"
