---
'@loombox/node': minor
---

Add GitHub `TrackerBackend` transitions, live tracker slice 2 (SPEC §7.10, issue #215)

`GithubTrackerBackend` now implements `listTransitions`/`transition`, GitHub's fixed two-state model rather than a discovered per-project workflow: `listTransitions` reports `close_completed`/`close_not_planned` when the issue is currently open, and `reopen` when it is closed, by reading the issue's current `state` first. `transition` applies one of those by `PATCH .../issues/{n} {state, state_reason}` (SPEC §7.10), so closing as completed and closing as not planned are distinct, inspectable outcomes end to end — a subsequent read reports the applied `fields.stateReason`, never a bare "closed". An unknown `transitionId` is rejected with `GithubTrackerAccessError` before any request is made.

`capabilities.transitions` flips to `true`; `boards`/`sprints` are unchanged (still `false`, deferred to #218). Slice 1's `list`/`get`/`create`/`update`/`addComment`/`listBindings` behaviour is untouched.
