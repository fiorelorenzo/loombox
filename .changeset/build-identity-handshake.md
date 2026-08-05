---
'@loombox/protocol': minor
'@loombox/relay': minor
'@loombox/node': minor
'@loombox/web': minor
---

Peers announce a build identity alongside the protocol version, and a build mismatch is now visible on a node's own row instead of staying invisible until someone SSHes in and reads process start times (issue #655)

On 2026-08-04 my resident node had been running since 29 July, across roughly fifty merged PRs including wire-level changes, and it connected to a freshly deployed relay without a word. That is the check working as designed and the design being too coarse: PROTOCOL_V1 has been 1 since the beginning and bumps only on a breaking wire change, so two peers built a week apart both announce it and shake hands happily while silently disagreeing about what several fields mean.

`initialize`/`initialize_result` now carry an optional `buildIdentity` (package.json version plus, when honestly recoverable, the commit): a node reads its own git HEAD at startup (it runs unbundled from a checkout via tsx, so this is free, no new build step), and the relay reads `LOOMBOX_BUILD_COMMIT` in production (passed through from the exact `$SHA` deploy-prod.sh already writes to DEPLOYED.json) or falls back to git rev-parse in dev. Both fields are additive and optional; a peer that predates this change still connects exactly as before.

The relay records each connected node's build identity and exposes it on `target_list` entries (`build`), mirroring how `reachable` already works: live-connection-derived, absent for an offline node or one that predates the field. `buildIdentityMismatch` in `@loombox/protocol` is a pure equality/absence check, never version parsing or ordering, matching this issue's own constraint that feature detection stays the protocol's job.

The client shows a node's version on its own row (`TargetStatusView`) and adds a quiet "Behind" badge when it differs from what the relay itself is serving (`RelayClient.relayBuildIdentity`, from the client's own `initialize_result`). Three outcomes: same protocol and build stays silent, same protocol with a different build connects and gets the badge, an incompatible protocol is still refused via the existing `update_required` path, unchanged.
