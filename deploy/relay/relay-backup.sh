#!/usr/bin/env bash
# Nightly relay backup wrapper (#103) - meant to run from a systemd timer or
# cron on prodbox. Runs the backup CLI inside the already-running `relay`
# container (it has DATABASE_URL, network access to `postgres`, and a
# version-matched pg_dump baked into the image - see ../../packages/relay/
# Dockerfile), and writes the encrypted artifact to ./backups on the host
# (bind-mounted, see docker-compose.yml) for an off-box shipping step to pick
# up. See docs/relay-backup.md for the full runbook.
#
# Usage: ./relay-backup.sh   (run from this directory, or set RELAY_DEPLOY_DIR)
set -euo pipefail
cd "${RELAY_DEPLOY_DIR:-$(dirname "${BASH_SOURCE[0]}")}"

# shellcheck disable=SC1091
set -a
source .env
set +a

: "${RELAY_BACKUP_ENCRYPTION_KEY:?set RELAY_BACKUP_ENCRYPTION_KEY in .env (generate: openssl rand -base64 32)}"

docker compose exec -T \
  -e RELAY_BACKUP_ENCRYPTION_KEY \
  -e RELAY_BACKUP_DIR=/app/backups \
  -e RELAY_BACKUP_RETENTION_COUNT="${RELAY_BACKUP_RETENTION_COUNT:-14}" \
  relay pnpm --filter @loombox/relay backup

# Off-box shipping (rclone/restic) - uncomment and configure once a remote is
# set up (docs/relay-backup.md "Off-box shipping"):
# rclone copy ./backups <remote>:loombox-relay-backups --min-age 5m
