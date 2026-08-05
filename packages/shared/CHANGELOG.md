# @loombox/shared

## 0.2.4

### Patch Changes

- Updated dependencies [6f90259]
- Updated dependencies [e6c44d0]
- Updated dependencies [9b5f66a]
  - @loombox/protocol@0.6.0

## 0.2.3

### Patch Changes

- Updated dependencies [35f3924]
  - @loombox/protocol@0.5.1

## 0.2.2

### Patch Changes

- Updated dependencies [a1038bf]
  - @loombox/protocol@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [7606627]
- Updated dependencies [ebcf227]
  - @loombox/protocol@0.4.0

## 0.2.0

### Minor Changes

- 2592c10: Add Jira `TrackerBackend` workflow transitions, live tracker slice 2 (SPEC §7.10, issue #216)

  `JiraTrackerBackend` now implements `listTransitions`/`transition` by discovering Jira's real, per-project/per-issue-type workflow at runtime instead of assuming a fixed set: `listTransitions` calls `GET .../issue/{key}/transitions` and maps each entry to `{id, name, requiresFields}`, where `requiresFields` is read straight off Jira's own per-transition workflow-screen field map (`required: true`) — most commonly seen on a "Done"-category move that needs a `resolution`. `transition` posts the chosen id via `POST .../issue/{key}/transitions` and accepts an optional fourth argument (`options.fields`/`options.comment`) beyond `TrackerBackend.transition`'s own three-parameter shape, so a Jira-aware caller can supply what a field-requiring move needs; `options.comment` is converted to Atlassian Document Format the same way `addComment` does, sent as `update.comment`. If Jira's own workflow validation still rejects the request over a missing required field, that surfaces as a new typed `JiraTrackerTransitionValidationError` (carrying Jira's per-field messages) — never silently dropped, and never reported as a success.

  `capabilities.transitions` flips to `true`; `boards`/`sprints` are unchanged (still `false`, deferred to #217). Slice 1's `list`/`get`/`create`/`update`/`addComment`/`listBindings` behaviour is untouched, both REST bases (OAuth 3LO `api.atlassian.com/ex/jira/{cloudId}` and direct-site API-token) are exercised for the new calls, and `@loombox/shared`'s `TrackerTransition` gets a new optional `requiresFields` field (GitHub's already-shipped fixed two-state transitions never set it).

### Patch Changes

- Updated dependencies [535a2ee]
- Updated dependencies [99e3583]
- Updated dependencies [e05423a]
- Updated dependencies [635e20d]
  - @loombox/protocol@0.3.0

## 0.1.0

### Minor Changes

- 804933f: Add the native tracker's `TrackerRecord` data model and node-side storage (SPEC §7.10 "Native mode")

  `@loombox/shared` gets `tracker-record.ts`: `TrackerRecord` (a `fields` business-data bag, a `system` object holding author/linked commits/PRs/sessions/activity/comments, and real queryable columns — `id`/`primaryType`/`typeTags`/`issueNumber`/`archived`/`createdAt`/`updatedAt` — around both), `TrackerTypeDefinition` with a `roles` mapping (`title`/`workflowStatus`/`priority`/`assignee`), the three built-in types (Task/Bug/Epic), and `resolveRoleValue`/`groupByWorkflowStatus`/`sortByPriority`/`filterByAssignee`, the role-driven query helpers that make a kanban board, priority sort, and assignee filter work identically whether a record's type is built-in or project-defined. `buildTrackerIndex` builds the in-memory secondary indexes (by id/issue number/primary type/tag, plus active/archived partitions) a non-SQL store needs for real lookups. No `syncStatus`/team-sync field exists anywhere in this shape, enforced by both a compile-time type guard and a runtime test — the native tracker is per-operator by design (SPEC §7.10).

  `@loombox/node` gets `NativeTrackerStore`: a single JSON file per node (mirroring `SessionStore`/`McpConfigStore`'s established shape), keyed by project path, holding each project's custom type definitions and tracker records. This follows the node's existing persistence idiom deliberately rather than introducing a new SQL dependency: every store this package already has is a JSON file, the one SQL engine in the monorepo (`better-sqlite3`) is only ever a Postgres test double for the relay's Better Auth tables, and a native tracker's per-operator, single-writer data doesn't need the relational query planning a real database buys. `create`/`get`/`update`/`list`/`defineType`/`linkSession`/`linkCommit`/`linkPullRequest`/`addComment` round-trip both built-in and custom-type records; `index()` exposes the store's current secondary indexes.

  No consumer wires this into the MCP tool contract or a UI yet — that's issues #211 and #212.

- c97a2cf: Add the `TrackerMode` config and the pluggable `TrackerBackend` extension point (SPEC §7.10)

  `@loombox/protocol` gets `v1/tracker.ts`: Zod-validated `githubTarget`/`jiraTarget` and the `trackerMode` discriminated union (`{kind:'native'}` or `{kind:'live', provider, connectionId, target}`), exported and registered in `schemasV1` alongside every other v1 schema. The exported `TrackerMode` type keeps SPEC's literal `target: GitHubTarget | JiraTarget` shape (not correlated to `provider` at the type level, exactly as specced), but the schema adds a `superRefine` cross-check so a GitHub-shaped target submitted under `provider: 'jira'` (or the reverse) is rejected at parse time, since that correlation is clearly the spec's intent even though its type block does not encode it.

  `@loombox/shared` gets its first real export: `TrackerBackend` and `TrackerBackendCapabilities`, plus the `TrackerBinding`/`TrackerListFilter`/`TrackerListPage`/`TrackerItemLive`/`TrackerTransition`/`TrackerBoard`/`TrackerSprint` shapes those methods reference. `list`/`get`/`create`/`update`/`listBindings` are required; `addComment`/`listTransitions`/`transition`/`listBoards`/`listSprints`/`moveToSprint` are optional, matching SPEC §7.10's phased delivery (issues/comments first, transitions next, boards/sprints last). A type-level `satisfies TrackerBackend` check in `tracker-backend.test.ts` proves a stub implementing only the required methods still satisfies the interface with every optional method absent, and fails to compile if that ever stops being true.

  `apps/web` gets `$lib/tracker-mode-store.ts`, a per-project persisted `TrackerMode` (localStorage today, same injectable-storage pattern as `mcp-server-store.ts`/`plugin-store.ts`). `get()` returns `TrackerMode | undefined`: an unset project, or one whose stored value no longer validates, both read as `undefined`, never silently coerced to `{kind:'native'}`. No consumer wires this store into the UI yet; that is issue #212's job.

### Patch Changes

- Updated dependencies [5118b26]
- Updated dependencies [a449b22]
- Updated dependencies [c97a2cf]
  - @loombox/protocol@0.2.0
