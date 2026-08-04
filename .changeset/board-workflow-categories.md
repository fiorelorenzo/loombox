---
'@loombox/protocol': patch
'@loombox/node': patch
'@loombox/web': patch
---

Group the tracker kanban board into three fixed workflow-category columns instead of one column per raw status

The board rendered one column per distinct `workflowStatus` value, sorted
alphabetically — "Done" sorted ahead of "In progress"/"Todo", reading the
workflow backwards, and a status with zero records never rendered a
column at all, so the board changed shape as work moved and nothing
could be dragged into an empty state (issue #651, superseded in scope by
v7 decision F4-2, `2026-08-04-cockpit-v7-decisions.md` §6).

The board now always renders exactly three columns, in workflow order —
To Do / In Progress / Done — derived from the tracker rather than
hand-written per component: `@loombox/protocol` gets
`resolveWorkflowCategory`/`groupByWorkflowCategory`, which collapse
loombox's own local status vocabulary into the same
`new`/`indeterminate`/`done` ids Jira's `statusCategory` already uses
verbatim. `TrackerBoard.svelte`/`TrackerCard.svelte` group and move
records by category id, never a raw status string, and an empty category
still renders its column and still accepts a drop. Three fixed `18rem`
columns fit any real laptop width with no horizontal scroller — the
six-raw-status board this replaces could overflow one (1778px of content
measured in a 1080px container).

`@loombox/node`'s Jira and GitHub `TrackerBackend`s gain the matching
`workflowCategory` field on every `TrackerItemLive` they return
(`deriveJiraWorkflowCategory` reads Jira's own `status.statusCategory.key`
verbatim; `deriveGithubWorkflowCategory` maps GitHub's `open`/`closed`
state, since GitHub has no third state of its own). Neither is reachable
by the board yet — `NodeDaemon.readTrackerSnapshotForBridge` always reads
the native store regardless of `TrackerMode` (issue #631) — so only the
local/native half of this is proven live end to end; the Jira/GitHub
category derivation is unit-tested against realistic API payload
fixtures pending #631.
