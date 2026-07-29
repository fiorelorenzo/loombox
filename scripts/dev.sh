#!/usr/bin/env bash
#
# dev.sh — the local loombox dev loop: relay + node daemon + web PWA, all
# running as plain host processes (tsx watch / vite dev) for real HMR and
# attachable debuggers, at production parity — real Postgres, real Better
# Auth, real GitHub OAuth device/session flows. No offline/stub mode: that
# parity is deliberate, see AGENTS.md.
#
# Usage:
#   scripts/dev.sh              # bring the loop up (first run creates
#                                # .env.dev.local and tells you what to fill in)
#   scripts/dev.sh --fresh      # + wipe the dev Postgres volume first
#   scripts/dev.sh --no-mac     # skip the reverse SSH forwards to the Mac
#   scripts/dev.sh --stop       # tear everything down, including Postgres
#
# Port map. Fixed, not env-overridable: the GitHub OAuth App's callback URL
# and LOOMBOX_TRUSTED_ORIGINS below are registered against these exact
# ports, so a "just use another port" override would silently break login.
# The values are deliberately unusual because this box is shared with other
# projects, and the obvious choices were already taken when this was written
# (an unrelated container on 5433, a leaked assay dev server on 8787). The
# preflight below reports the squatter by name rather than failing obscurely.
#   postgres        127.0.0.1:5435
#   relay           127.0.0.1:8790   (ws://localhost:8790/ws)
#   web             127.0.0.1:5173   (http://localhost:5173, HMR)
#   relay inspector 127.0.0.1:9230
#   node inspector  127.0.0.1:9231
#
# Ctrl+C stops relay/node/web but leaves Postgres running (it holds your
# account and sessions — tearing it down every time would mean re-onboarding
# through GitHub OAuth and recovery-code setup on every loop restart).
# `--stop` is the explicit "actually stop Postgres too" action.
#
# One-time setup: copy .env.dev.example to .env.dev.local (this script does
# it for you on first run) and fill in a GitHub OAuth App's client id/secret
# — see .env.dev.example for the exact steps and why.
set -euo pipefail

# mise is not loaded in non-interactive shells on the dev box (see
# scripts/run-relay.sh, the same guard).
if [ -x "$HOME/.local/bin/mise" ]; then
  eval "$("$HOME/.local/bin/mise" activate bash)"
fi

cd "$(dirname "$0")/.."

# --- fixed config: see the port-map comment above for why these aren't env-
# overridable like scripts/mac-desktop.sh's ports are.
readonly DEV_POSTGRES_PORT=5435
readonly RELAY_PORT=8790
readonly WEB_PORT=5173
readonly RELAY_INSPECT_PORT=9230
readonly NODE_INSPECT_PORT=9231
readonly COMPOSE_FILE="deploy/dev/docker-compose.yml"
readonly ENV_EXAMPLE=".env.dev.example"
readonly ENV_FILE=".env.dev.local"
MAC_HOST="${MAC_HOST:-mac}"
COMPOSE=(docker compose -f "$COMPOSE_FILE" -p loombox-dev)

# Unique substrings of each dev process's own argv, used by cleanup() below
# to actually stop them (mirrors scripts/mac-desktop.sh's `pkill -f` idiom —
# tracking raw PIDs across a `pnpm exec` -> tsx -> node child chain is
# fragile; matching the always-present --inspect port is not, and also
# matches a leftover child even if the watcher itself already exited).
readonly RELAY_PATTERN="--inspect=127.0.0.1:${RELAY_INSPECT_PORT}"
readonly NODE_PATTERN="--inspect=127.0.0.1:${NODE_INSPECT_PORT}"
readonly WEB_PATTERN="vite dev --host 127.0.0.1 --port ${WEB_PORT}"
readonly MAC_FWD_ARGS="-f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -R ${WEB_PORT}:127.0.0.1:${WEB_PORT} -R ${RELAY_PORT}:127.0.0.1:${RELAY_PORT}"

# --- flags -------------------------------------------------------------
STOP=0
FRESH=0
NO_MAC=0
for arg in "$@"; do
  case "$arg" in
    --stop) STOP=1 ;;
    --fresh) FRESH=1 ;;
    --no-mac) NO_MAC=1 ;;
    *)
      echo "!! unknown flag: $arg (known: --stop, --fresh, --no-mac)" >&2
      exit 2
      ;;
  esac
done

# Stops the three dev processes (leaves Postgres running) or, with
# --stop/--fresh, also touches the docker compose stack — see call sites.
stop_dev_processes() {
  # pkill treats a pattern that itself starts with "--" as an (unrecognized)
  # option rather than the positional pattern unless "--" ends option
  # parsing first — confirmed the hard way: `pkill -f "--inspect=..."` fails
  # with "unrecognized option" and kills nothing, silently, since callers
  # below swallow its exit status. RELAY_PATTERN/NODE_PATTERN both start
  # with "--inspect=...", so both need it; WEB_PATTERN/the ssh pattern don't
  # (they start with "vite"/"ssh"), but "-f --" is harmless there too.
  pkill -f -- "$RELAY_PATTERN" 2>/dev/null || true
  pkill -f -- "$NODE_PATTERN" 2>/dev/null || true
  pkill -f -- "$WEB_PATTERN" 2>/dev/null || true
  pkill -f -- "ssh $MAC_FWD_ARGS $MAC_HOST" 2>/dev/null || true
}

if [ "$STOP" = 1 ]; then
  echo ">> stopping the dev loop, including postgres"
  stop_dev_processes
  "${COMPOSE[@]}" down
  echo ">> done (the postgres data volume was kept — pass --fresh next time to wipe it too)"
  exit 0
fi

# Runs cleanup exactly once, on Ctrl+C, on a later `exit 1`, or on normal
# script end (e.g. a watched process crashed and `wait` returned) — trapped
# on EXIT/INT/TERM, self-disarming so it can't recurse. Captures $? BEFORE
# any of its own commands can overwrite it, and re-exits with that same
# code, so an earlier failure (e.g. relay never got healthy) still reports
# non-zero after cleanup runs.
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  echo
  echo ">> stopping relay/node/web (postgres stays up — scripts/dev.sh --stop to also stop it)"
  stop_dev_processes
  exit "$exit_code"
}

# Polls "$1" (a plain liveness GET) up to "$2" times, 1s apart.
wait_for_http() {
  local url="$1" tries="$2"
  for _ in $(seq 1 "$tries"); do
    curl -sf -o /dev/null --max-time 2 "$url" && return 0
    sleep 1
  done
  return 1
}

# Polls the compose postgres service's own pg_isready up to "$1" times, 1s
# apart — the same check the container's healthcheck runs, from outside it.
wait_for_postgres() {
  local tries="$1"
  for _ in $(seq 1 "$tries"); do
    "${COMPOSE[@]}" exec -T postgres pg_isready -U loombox -d loombox >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# Refuses to start when one of the fixed ports is already taken, naming who
# holds it. Worth the lines: this box is shared with other projects whose
# leaked dev servers and stray containers squat ports for days (see the
# port-map comment), and the failures you get otherwise are all misleading -
# docker reports "port is already allocated", vite silently picks the next
# free port so the app loads on a URL the OAuth callback does not match, and
# a relay that cannot bind just looks like "never got healthy".
#
# Our own leftovers are not conflicts: postgres is deliberately left running
# between loops, and a previous run's relay/node/web may still be shutting
# down, so anything belonging to this stack is stopped or reused rather than
# reported.
preflight_ports() {
  local blocked=0 port label holder
  for entry in \
    "$DEV_POSTGRES_PORT:postgres" \
    "$RELAY_PORT:relay" \
    "$WEB_PORT:web" \
    "$RELAY_INSPECT_PORT:relay inspector" \
    "$NODE_INSPECT_PORT:node inspector"; do
    port="${entry%%:*}"
    label="${entry#*:}"
    ss -ltn 2>/dev/null | grep -qE "[:.]${port}[[:space:]]" || continue

    # Ours? Then it is not a conflict. `ss -ltnp` only reveals the process
    # for our own sockets, so ask docker as well when nothing owns it here.
    if docker ps --format '{{.Label "com.docker.compose.project"}} {{.Ports}}' 2>/dev/null |
      grep -E "[:.]${port}->" | grep -q '^loombox-dev '; then
      continue
    fi
    holder="$(ss -ltnp 2>/dev/null | grep -E "[:.]${port}[[:space:]]" |
      grep -oE '"[^"]+",pid=[0-9]+' | head -1 | tr -d '"')"
    if [ -n "$holder" ] && pgrep -f "$RELAY_PATTERN|$NODE_PATTERN|$WEB_PATTERN" >/dev/null 2>&1; then
      # A previous run of this very script. stop_dev_processes below clears
      # it, so say so instead of refusing.
      echo ">> reclaiming port ${port} (${label}) from a previous dev loop"
      stop_dev_processes
      continue
    fi
    if [ -z "$holder" ]; then
      holder="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null |
        grep -E "[:.]${port}->" | awk '{print "docker container " $1}' | head -1)"
    fi
    echo "!! port ${port} (${label}) is already in use${holder:+ by ${holder}}" >&2
    blocked=1
  done
  if [ "$blocked" = 1 ]; then
    cat >&2 <<EOF

   These ports are fixed on purpose (the GitHub OAuth callback is registered
   against them), so free the port rather than changing it here. If the
   squatter is a leaked dev server from another project, note that
   ~/.local/bin/emdash-session-janitor.sh reaps those on a schedule.
EOF
    return 1
  fi
}

# --- .env.dev.local: create-and-teach on first run, then load ----------
if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  cat <<EOF
>> created $ENV_FILE from $ENV_EXAMPLE — fill in two values before running
   this again:

     GITHUB_CLIENT_ID=...
     GITHUB_CLIENT_SECRET=...

   These come from a GitHub OAuth App you register once, about two minutes:
     1. https://github.com/settings/developers -> OAuth Apps -> New OAuth App
     2. Homepage URL:               http://localhost:${WEB_PORT}
     3. Authorization callback URL: http://localhost:${RELAY_PORT}/api/auth/callback/github
     4. Register, then "Generate a new client secret", and paste both values
        into $ENV_FILE.

   See $ENV_EXAMPLE for why localhost (never this box's tailnet IP) matters
   here. Everything else in that file is optional at first run.
EOF
  exit 1
fi

set -a
# $ENV_FILE is gitignored and operator-local, so there is nothing on disk
# for shellcheck to statically follow — this is intentional dynamic
# sourcing, not a missing-file bug (SC1090's own recommended fix).
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
  GENERATED_SECRET="$(openssl rand -base64 32)"
  if grep -q '^BETTER_AUTH_SECRET=' "$ENV_FILE"; then
    # '|' delimiter: base64 output can contain '/', never '|'.
    sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${GENERATED_SECRET}|" "$ENV_FILE"
  else
    printf '\nBETTER_AUTH_SECRET=%s\n' "$GENERATED_SECRET" >>"$ENV_FILE"
  fi
  BETTER_AUTH_SECRET="$GENERATED_SECRET"
  echo ">> generated a BETTER_AUTH_SECRET into $ENV_FILE"
fi
export BETTER_AUTH_SECRET

if [ -z "${GITHUB_CLIENT_ID:-}" ] || [ -z "${GITHUB_CLIENT_SECRET:-}" ]; then
  echo "!! GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are empty in $ENV_FILE" >&2
  echo "   register a GitHub OAuth App and fill both in — see $ENV_EXAMPLE for the" >&2
  echo "   exact steps (Homepage http://localhost:${WEB_PORT}, callback" >&2
  echo "   http://localhost:${RELAY_PORT}/api/auth/callback/github)." >&2
  exit 1
fi

# Before anything binds: a squatted port here is the single most likely way
# this loop goes wrong on a shared box, and every downstream symptom of it
# misleads.
preflight_ports || exit 1

# --- postgres ------------------------------------------------------------
if [ "$FRESH" = 1 ]; then
  echo ">> --fresh: dropping the dev postgres volume for a clean database"
  "${COMPOSE[@]}" down -v
fi

echo ">> starting dev postgres (127.0.0.1:${DEV_POSTGRES_PORT})"
"${COMPOSE[@]}" up -d
echo -n ">> waiting for postgres to be healthy"
if wait_for_postgres 30; then
  echo " — ok"
else
  echo
  echo "!! postgres did not become healthy within 30s; check: docker compose -f $COMPOSE_FILE logs postgres" >&2
  exit 1
fi

# From here on, every dev process we start needs tearing down on exit —
# arm the trap now rather than at the top, so an early exit above (missing
# GitHub credentials, postgres never healthy) doesn't print a "stopping..."
# line for processes that were never started.
trap cleanup EXIT INT TERM

# --- relay -----------------------------------------------------------------
export DATABASE_URL="postgresql://loombox:loombox@127.0.0.1:${DEV_POSTGRES_PORT}/loombox"
export RELAY_PUBLIC_URL="http://localhost:${RELAY_PORT}"
# The web app's origin must be trusted or Better Auth 403s every browser
# auth call (packages/relay/src/main.ts's own doc comment).
export LOOMBOX_TRUSTED_ORIGINS="http://localhost:${WEB_PORT}"
# Not in the brief's own env list, but genuinely required for a correct dev
# loop: device-auth-routes.ts builds the node's device-login verification_uri
# from this, defaulting to the PRODUCTION app (device-auth.ts's
# DEFAULT_APP_URL = https://app.loombox.dev) when unset. Without overriding
# it here, a node started against this dev relay would print a code to
# approve on the *production* site, which can never approve it.
export LOOMBOX_APP_URL="http://localhost:${WEB_PORT}"
export HOST="127.0.0.1"
export PORT="$RELAY_PORT"
export GITHUB_CLIENT_ID
export GITHUB_CLIENT_SECRET

echo ">> starting relay (tsx watch, inspector on 127.0.0.1:${RELAY_INSPECT_PORT})"
(pnpm --filter @loombox/relay exec tsx watch --inspect="127.0.0.1:${RELAY_INSPECT_PORT}" src/main.ts 2>&1 | sed -u 's/^/[relay] /') &

echo -n ">> waiting for relay /health"
if wait_for_http "http://127.0.0.1:${RELAY_PORT}/health" 30; then
  echo " — ok"
else
  echo
  echo "!! relay did not answer /health within 30s — see the [relay] lines above" >&2
  exit 1
fi

# --- node daemon -------------------------------------------------------
# Dev-specific state dir (identity keypair, persisted device token) so this
# never shares state with a real resident node already running on this host
# (packages/node/src/config.ts's LOOMBOX_NODE_STATE_DIR).
NODE_STATE_DIR="${LOOMBOX_NODE_STATE_DIR:-$HOME/.loombox/node-dev}"
NODE_ID="${LOOMBOX_NODE_ID:-dev-$(hostname -s 2>/dev/null || echo devbox)}"
export LOOMBOX_RELAY_URL="ws://127.0.0.1:${RELAY_PORT}/ws"
export LOOMBOX_NODE_ID="$NODE_ID"
export LOOMBOX_NODE_STATE_DIR="$NODE_STATE_DIR"
# LOOMBOX_RECOVERY_CODE, if set, is already exported from $ENV_FILE above
# (set -a). LOOMBOX_AUTH_TOKEN deliberately is NOT required here: a node with
# no token runs the device-authorization flow itself (main.ts's `start`),
# prints a short code to approve in the browser, and persists the token it
# mints under the state dir above, so every later run just reuses it.
# Demanding the token up front would block the only flow that produces one.
HAVE_AMK_SOURCE=1
if [ -z "${LOOMBOX_RECOVERY_CODE:-}" ] && [ -z "${LOOMBOX_AMK:-}" ] && [ -z "${LOOMBOX_WRAPPED_AMK_FILE:-}" ]; then
  HAVE_AMK_SOURCE=0
fi
NODE_STARTED=0

if [ "$HAVE_AMK_SOURCE" = 1 ]; then
  echo ">> starting node (tsx watch, inspector on 127.0.0.1:${NODE_INSPECT_PORT}, state dir $NODE_STATE_DIR)"
  if [ ! -s "$NODE_STATE_DIR/device-token.json" ] && [ -z "${LOOMBOX_AUTH_TOKEN:-}" ]; then
    echo "   first run for this state dir: the node will print a code to approve"
    echo "   at http://localhost:${WEB_PORT}/device in the browser you signed in with."
  fi
  (pnpm --filter @loombox/node exec tsx watch --inspect="127.0.0.1:${NODE_INSPECT_PORT}" src/main.ts 2>&1 | sed -u 's/^/[node]  /') &
  NODE_STARTED=1
else
  cat <<EOF
>> node: skipped — relay + web are still starting fine without it (a
   half-configured loop is still useful). The node needs your account's E2E
   key, which it can only get from your Recovery Code:
     1. sign in at http://localhost:${WEB_PORT}
     2. set up a Recovery Code when the app asks (first device), or reuse the
        one you already saved
     3. put it in $ENV_FILE as LOOMBOX_RECOVERY_CODE and re-run this script
   The device token it also needs is NOT something you fetch by hand: the node
   mints it on first run through the approval flow described above.
EOF
fi

# --- web ---------------------------------------------------------------
# apps/web reads this via SvelteKit's $env/dynamic/public (+page.svelte),
# never $env/static/public, so it's a plain runtime env var here, not
# something baked into a build.
export PUBLIC_LOOMBOX_RELAY_URL="ws://localhost:${RELAY_PORT}/ws"
echo ">> starting web (vite dev, HMR on 127.0.0.1:${WEB_PORT})"
(pnpm --filter @loombox/web exec vite dev --host 127.0.0.1 --port "$WEB_PORT" 2>&1 | sed -u 's/^/[web]   /') &

# --- mac reverse forwards ------------------------------------------------
if [ "$NO_MAC" = 1 ]; then
  echo ">> --no-mac: skipping reverse forwards"
elif ssh -o BatchMode=yes -o ConnectTimeout=5 "$MAC_HOST" true 2>/dev/null; then
  echo ">> mac reachable — opening reverse forwards (its localhost -> this loop)"
  # A stale forward from a previous run answers nothing useful; replace it
  # rather than stack a duplicate — same idiom as mac-desktop.sh's forward().
  pkill -f -- "ssh $MAC_FWD_ARGS $MAC_HOST" 2>/dev/null || true
  # shellcheck disable=SC2086  # MAC_FWD_ARGS is a fixed set of ssh flags; word-splitting is the point
  # shellcheck disable=SC2029  # $MAC_HOST is ssh's destination argument, not a remote command: -N runs none, so client-side expansion here is correct
  if ssh $MAC_FWD_ARGS "$MAC_HOST"; then
    echo "   done — on the Mac, http://localhost:${WEB_PORT} is a real secure context, no flags needed"
  else
    echo "   !! could not open the reverse forward; continuing without it" >&2
  fi
else
  echo ">> mac not reachable over ssh — skipping reverse forwards (pass --no-mac to silence this)"
fi

# --- summary -------------------------------------------------------------
cat <<EOF

>> loombox dev loop is up
     web              http://localhost:${WEB_PORT}
     relay            http://localhost:${RELAY_PORT}  (ws://localhost:${RELAY_PORT}/ws)
     postgres         127.0.0.1:${DEV_POSTGRES_PORT}  (loombox/loombox/loombox)
     relay inspector  127.0.0.1:${RELAY_INSPECT_PORT}
     node inspector   127.0.0.1:${NODE_INSPECT_PORT}$([ "$NODE_STARTED" = 1 ] || echo '  (node not running — see above)')

   next: open http://localhost:${WEB_PORT} and sign in with GitHub.
   attach a debugger: chrome://inspect on this box (or VS Code's "Attach to
   Node Process") against 127.0.0.1:${RELAY_INSPECT_PORT} for the relay and
   127.0.0.1:${NODE_INSPECT_PORT} for the node.
   Ctrl+C here stops relay/node/web; postgres stays up. scripts/dev.sh --stop
   also stops postgres. scripts/dev.sh --fresh wipes it for a clean database.
EOF

echo ">> watching relay/node/web — Ctrl+C to stop"
wait
