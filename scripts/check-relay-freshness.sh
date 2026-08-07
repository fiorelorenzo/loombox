#!/usr/bin/env bash
#
# check-relay-freshness.sh — answers "is the running relay behind main?"
# without SSH-ing anywhere (issue #657). Run from any machine with a git
# checkout of this repo and network access to the relay's public /health
# endpoint: the devbox, a laptop, or a cron job on either.
#
# scripts/deploy-prod.sh's own update path (a v* tag push, see AGENTS.md's
# "Shipping to prod") runs only when Lorenzo pushes one, so the relay stays
# current only while someone remembers to look — issue #657's own "no
# notification that a deploy is available or overdue" gap. This script is
# the practical answer: it reads the SAME build-identity data #655 already
# put on the wire (echoed on /health since #657, next to the compatibility
# window it enforces) and compares the commit against origin/main.
#
# Usage:
#   scripts/check-relay-freshness.sh                          # https://relay.loombox.dev
#   RELAY_URL=https://preview-relay.loombox.dev scripts/check-relay-freshness.sh
#
# Exit codes (cron/alerting-friendly): 0 current, 1 strictly behind main
# (actionable — push a tag), 2 the question itself couldn't be answered
# (relay unreachable, this relay predates #655's build identity, or the
# reported commit isn't in this checkout's history to compare against —
# each printed plainly rather than guessed at).
set -euo pipefail
cd "$(dirname "$0")/.."

RELAY_URL="${RELAY_URL:-https://relay.loombox.dev}"

# Comparing against a stale local idea of origin/main would silently lie in
# the "current" direction (a relay actually behind would look current
# against an equally-stale local ref) — this network round trip is the
# price of the check meaning anything.
git fetch origin main --quiet

health="$(curl -fsS --max-time 10 "$RELAY_URL/health")" || {
  echo "UNKNOWN: could not reach $RELAY_URL/health" >&2
  exit 2
}

status="$(echo "$health" | jq -r '.status')"
if [ "$status" != "ok" ]; then
  echo "UNKNOWN: $RELAY_URL/health reports status=$status, not ok — fix that before asking about freshness" >&2
  echo "$health" >&2
  exit 2
fi

relay_commit="$(echo "$health" | jq -r '.build.commit // empty')"
relay_version="$(echo "$health" | jq -r '.build.version // empty')"
if [ -z "$relay_commit" ]; then
  echo "UNKNOWN: $RELAY_URL/health carries no build.commit — this relay predates issue #655's build identity, or LOOMBOX_BUILD_COMMIT/git rev-parse both failed on the host (see build-identity.ts)" >&2
  exit 2
fi

main_sha="$(git rev-parse origin/main)"
if [ "$relay_commit" = "$main_sha" ]; then
  echo "current: relay is on origin/main ($relay_version @ ${relay_commit:0:12})"
  exit 0
fi

if ! git cat-file -e "$relay_commit^{commit}" 2>/dev/null; then
  echo "UNKNOWN: relay reports commit $relay_commit ($relay_version), which is not in this checkout's history — fetch more history, or this relay is running something off-mainline (deploy-web.sh's fast-iteration path, e.g.)" >&2
  exit 2
fi

if git merge-base --is-ancestor "$relay_commit" "$main_sha"; then
  behind="$(git rev-list --count "$relay_commit".."$main_sha")"
  echo "BEHIND: relay is on $relay_version @ ${relay_commit:0:12}, $behind commit(s) behind origin/main ($main_sha)"
  echo "  -> git tag -a vX.Y.Z -m '...' && git push origin vX.Y.Z   (AGENTS.md: Shipping to prod)"
  exit 1
fi

# The relay's commit exists locally but main never merged it (e.g. main was
# force-pushed/rebased past it, or deploy-web.sh put an off-mainline commit
# live) — genuinely ahead-or-diverged, not "behind" in the sense that
# pushing a tag from main would fix. Reported, not silently folded into
# either the "current" or "behind" verdict.
echo "UNKNOWN: relay's commit ($relay_commit) is not an ancestor of origin/main ($main_sha) — diverged, not simply behind" >&2
exit 2
