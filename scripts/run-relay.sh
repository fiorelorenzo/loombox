#!/usr/bin/env bash
#
# Bring up the loombox v0 relay for the transport-only Tailscale spike
# (SPEC §9 topology, §12 v0 "Transport-only over Tailscale"). This is the
# disposable v0 relay: in-memory only, no TLS, no Postgres/Redis. Running it
# behind Caddy with Let's Encrypt on prodbox is v1.
#
# Usage:
#   scripts/run-relay.sh                 # binds to this host's Tailscale IPv4
#   HOST=0.0.0.0 PORT=9000 scripts/run-relay.sh
#
# By default it binds to the tailnet address so another device on the same
# Tailscale network (a phone) can reach ws://<tailnet-ip>:<port>/ws, while the
# public internet cannot.
set -euo pipefail
cd "$(dirname "$0")/.."

# mise is not loaded in non-interactive shells on the dev box.
if [ -x "$HOME/.local/bin/mise" ]; then
  eval "$("$HOME/.local/bin/mise" activate bash)"
fi

if [ -z "${HOST:-}" ]; then
  HOST="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  HOST="${HOST:-0.0.0.0}"
fi
export HOST
export PORT="${PORT:-8787}"

echo "loombox relay -> ws://${HOST}:${PORT}/ws"
exec pnpm --filter @loombox/relay start
