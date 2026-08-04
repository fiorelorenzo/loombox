---
'@loombox/node': minor
'@loombox/shared': minor
---

Add Jira `TrackerBackend` workflow transitions, live tracker slice 2 (SPEC §7.10, issue #216)

`JiraTrackerBackend` now implements `listTransitions`/`transition` by discovering Jira's real, per-project/per-issue-type workflow at runtime instead of assuming a fixed set: `listTransitions` calls `GET .../issue/{key}/transitions` and maps each entry to `{id, name, requiresFields}`, where `requiresFields` is read straight off Jira's own per-transition workflow-screen field map (`required: true`) — most commonly seen on a "Done"-category move that needs a `resolution`. `transition` posts the chosen id via `POST .../issue/{key}/transitions` and accepts an optional fourth argument (`options.fields`/`options.comment`) beyond `TrackerBackend.transition`'s own three-parameter shape, so a Jira-aware caller can supply what a field-requiring move needs; `options.comment` is converted to Atlassian Document Format the same way `addComment` does, sent as `update.comment`. If Jira's own workflow validation still rejects the request over a missing required field, that surfaces as a new typed `JiraTrackerTransitionValidationError` (carrying Jira's per-field messages) — never silently dropped, and never reported as a success.

`capabilities.transitions` flips to `true`; `boards`/`sprints` are unchanged (still `false`, deferred to #217). Slice 1's `list`/`get`/`create`/`update`/`addComment`/`listBindings` behaviour is untouched, both REST bases (OAuth 3LO `api.atlassian.com/ex/jira/{cloudId}` and direct-site API-token) are exercised for the new calls, and `@loombox/shared`'s `TrackerTransition` gets a new optional `requiresFields` field (GitHub's already-shipped fixed two-state transitions never set it).
