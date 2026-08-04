# @loombox/shared

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
