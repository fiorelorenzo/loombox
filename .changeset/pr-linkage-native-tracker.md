---
'@loombox/node': minor
---

Write back a PR-open event onto the native tracker record a session is linked to (issue #241, SPEC §7.14): `NodeDaemon` now links `pr_open_request`'s resulting PR onto `system.linkedPullRequests` of whichever native `TrackerRecord` the session was linked to via `tracker_link_session`, honestly skipping sessions with no linked tracker item. `NativeTrackerStore.linkPullRequest` gains upsert semantics (`upsertPullRequestRef`): re-linking the exact same PR is a no-op, and linking a different PR number for the same `owner/repo` replaces the prior entry instead of duplicating it. Live-tracker projects are unaffected — that write-back path is issue #242.
