---
'@loombox/protocol': minor
'@loombox/relay': minor
'@loombox/node': minor
'@loombox/web': minor
---

Live tracker connectivity-error state and attention-inbox failure surface (SPEC §7.10/§7.13; issue #219)

A live tracker backend (GitHub/Jira) that cannot be reached now has an honest, three-way state instead of silently looking like an empty tracker: `reachable` (whether or not it returned any items), `unreachable` (network failure, timeout, a 5xx, or rate limiting — purely transient, nothing to reconfigure), and `authFailed` (no credential to attempt a call with, or the remote API rejected one — an expired/revoked token, requiring the user to reconnect the account in Settings).

`@loombox/node` adds `TrackerConnectivityWatcher`, a per-project polling engine mirroring `CiCheckWatcher` exactly (fixed interval, one poll per project regardless of how many sessions share it), and `classifyTrackerConnectivityError`, which classifies a `GithubTrackerBackend`/`JiraTrackerBackend` call failure into the two failure states. `NodeDaemon` re-watches every saved live-mode project on restart (`TrackerModeStore.list()`), watches/unwatches on `tracker_mode_set_request`, and fans each project's latest reading out to every session open on it.

`@loombox/protocol` adds `tracker_connectivity_status`, a session-scoped node-pushed message mirroring `ci_check_status`'s wire shape, routed through `@loombox/relay`'s existing per-session fan-out (`fanOutDirect`) — no new relay-side subscription registry needed.

`@loombox/web`'s `RelayClient.attentionInbox()` gains a `'tracker_failure'` class: it raises exactly one item per session for a failing tracker, clears it once the tracker recovers, and never duplicates across repeated polls, the same recompute-from-latest-state property `'ci_failure'` (issue #243) already has. `AttentionInbox.svelte` renders `unreachable`/`authFailed` with distinct wording and badges, since the corrective action differs.
