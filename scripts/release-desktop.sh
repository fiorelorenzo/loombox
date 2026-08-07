#!/usr/bin/env bash
#
# release-desktop.sh — Mac-only, run by hand: builds, signs and notarizes
# the desktop shell for the CURRENTLY CHECKED-OUT @loombox/desktop version,
# then attaches the artifacts to changesets' own GitHub Release for that
# version (issue #657) — the same `@loombox/desktop@<version>` tag
# `.github/workflows/release-desktop.yml` already attached Windows/Linux
# artifacts to (electron-builder.ts's `publish.tagNamePrefix` targets that
# exact tag on purpose; see its own comment). Nothing here creates a tag or
# a release: both already exist by the time this is worth running.
#
# Prerequisites (see apps/desktop/README.md's "Building & distributing"):
#   - Run on the Mac, on a checkout at the commit the version bump landed
#     on (usually just-pulled main).
#   - APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID set, for
#     notarization — electron-builder auto-discovers the signing identity
#     from the keychain, these three only gate notarization.
#   - `gh` authenticated (`gh auth status`).
#
# Usage:
#   scripts/release-desktop.sh
#
# This never touches prodbox, the running relay, or any resident node — it
# only builds locally and uploads to a GitHub Release.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "release-desktop.sh only runs on macOS: signing/notarization need this Mac's own keychain and Apple Developer certificate." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh (GitHub CLI) is required to upload release assets. Install it and run 'gh auth login' first." >&2
  exit 1
fi

PKG_VERSION="$(jq -r '.version' apps/desktop/package.json)"
TAG="@loombox/desktop@${PKG_VERSION}"

echo "==> @loombox/desktop ${PKG_VERSION} -> release tag ${TAG}"

if ! gh release view "$TAG" >/dev/null 2>&1; then
  echo "ERROR: no GitHub Release found for tag '$TAG' yet." >&2
  echo "This script attaches artifacts to a release changesets/action already created" >&2
  echo "(CONTRIBUTING.md's 'Releases' section) — merge that package's Version Packages PR" >&2
  echo "and pull main before running this." >&2
  exit 1
fi

if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
  echo "WARNING: APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID are not all set." >&2
  echo "The build will still be keychain-signed (electron-builder auto-discovers the" >&2
  echo "identity) but NOT notarized — Gatekeeper will refuse to open it on any Mac" >&2
  echo "other than one that already trusts your signing identity by hand." >&2
  read -r -p "Continue and publish it anyway? [y/N] " reply
  case "$reply" in
  y | Y) ;;
  *)
    echo "Aborted. Set the three APPLE_* vars and re-run to notarize." >&2
    exit 1
    ;;
  esac
fi

echo "==> pnpm --filter @loombox/desktop run package:mac"
pnpm --filter @loombox/desktop run package:mac

RELEASE_DIR="apps/desktop/release/production"
shopt -s nullglob
files=("$RELEASE_DIR"/*.dmg "$RELEASE_DIR"/*.zip "$RELEASE_DIR"/*.yml "$RELEASE_DIR"/*.blockmap)
if [ "${#files[@]}" -eq 0 ]; then
  echo "ERROR: no distributable artifacts found under $RELEASE_DIR — packaging must have failed silently." >&2
  exit 1
fi

echo "==> uploading to $TAG:"
printf '  %s\n' "${files[@]}"
gh release upload "$TAG" "${files[@]}" --clobber

echo "==> done. Verify:"
echo "    gh release view '$TAG' --json assets --jq '.assets[].name'"
