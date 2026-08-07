---
'@loombox/protocol': minor
'@loombox/node': patch
'@loombox/relay': minor
'@loombox/desktop': minor
---

Issue #657 (epic #653): the relay now declares and enforces a compatibility window, and the desktop shell updates itself.

`@loombox/protocol` gains `compatibilityWindowV1` (a relay's declared oldest-served node/client build, both bounds independently optional) and `isBelowCompatWindow`, backed by `compareBuildVersions` — the one place in this package allowed to compare build versions by order rather than equality, unlike #655's `buildIdentityMismatch`. `@loombox/node`'s `ssh/target-update-monitor.ts` now re-exports `compareBuildVersions` as its own `compareVersions` instead of keeping a second copy of the identical algorithm.

`@loombox/relay` reads the window from `LOOMBOX_MIN_NODE_VERSION`/`LOOMBOX_MIN_CLIENT_VERSION` (both unset by default — no behavior change for any relay running today) and refuses, via the existing `update_required` path #108 already uses for an incompatible protocol version, a peer whose `buildIdentity.version` is strictly below the floor for its role. A peer at or above the floor is unaffected — #655's own "Behind" badge is still what surfaces that gap, not a refusal. `/health` now echoes `build`/`compatWindow` when the relay is configured with either, so "is this deployment self-consistent" is answerable with one unauthenticated `curl`, no SSH — see `docs/deploy-relay.md`'s new "production update path" section and `scripts/check-relay-freshness.sh`.

`@loombox/desktop` now updates itself via `electron-updater` against a GitHub Releases feed (`electron-builder.ts`'s new `publish` config, channel-split so production and preview builds can never cross-update). `autoDownload`/`autoInstallOnAppQuit` are forced off: the tray's "Check for Updates" only ever detects a newer build, and "Restart to Update" is the one explicit, user-consented click that downloads and installs (epic #653's "no auto-update without consent"). Unverified from this headless devbox — real launchd/Squirrel/AppImage update mechanics only exercise on a real install; see the desktop README's "Self-update" section for exactly what is and isn't proven.
