# @loombox/shared

## 0.4.0

### Minor Changes

- 8ed4dd1: A board move on a live-mode tracker project (issue #651's kanban board, issue #696) now actually writes the moved-to category back through the external tracker, instead of forwarding a raw `workflowCategory`/`state` field patch the provider would ignore or reject. `TrackerTransition` gains an optional `targetCategory` (`@loombox/shared`) — the `WorkflowCategoryV1` a discovered transition lands on — which `GithubTrackerBackend`/`JiraTrackerBackend` both derive from the exact same mapping their own reads already use (`deriveGithubWorkflowCategory`/`deriveJiraWorkflowCategory`), never a second, hand-duplicated table. `NodeDaemon.applyLiveTrackerWrite`'s `update` op now runs every write through the new `applyLiveTrackerCategoryMove` (`tracker-live-bridge.ts`): a plain field edit or a same-category resubmit still forwards straight to `TrackerBackend.update`, but a genuine category move reads the item's current category, discovers its available transitions, posts the one matching the requested category, and only then patches the remaining fields. A move to a category no discovered transition reaches now surfaces as a typed `tracker_write_response` error (`LiveTrackerCategoryMoveError`) rather than silently succeeding at the wrong thing or reporting a success the board never actually landed.

### Patch Changes

- Updated dependencies [0edc522]
- Updated dependencies [c301908]
- Updated dependencies [304c608]
- Updated dependencies [c0491de]
- Updated dependencies [4284906]
- Updated dependencies [7542bb1]
- Updated dependencies [5977937]
- Updated dependencies [91491bc]
- Updated dependencies [b6fee51]
- Updated dependencies [b389ef8]
- Updated dependencies [4785b56]
- Updated dependencies [7104b07]
- Updated dependencies [18f2885]
- Updated dependencies [7cb3efa]
- Updated dependencies [d0a563e]
  - @loombox/protocol@0.9.0

## 0.3.0

### Minor Changes

- 9c20ae1: Surface failing CI checks in the attention inbox (SPEC §7.13/§7.14; issue #243)

  Issue #239's CI check watcher already streams a session's latest check-run state to the client over `ci_check_status`. This wires that state into the cross-project attention inbox as a real, live `'ci_failure'` item, following the exact conventions the inbox already uses for `permission`/`awaiting_input`/`session_outcome`:

  - `RelayClient` decrypts `ci_check_status` into a new per-session store and recomputes the inbox whenever it changes, same as the transcript/permission-queue stores already do. A session contributes a `'ci_failure'` item exactly while its latest known state is `'failing'` - independently of its live status, so a session can be idle/finished and have a failing check on its open PR at the same time. The item clears the instant a later poll reports anything else (`'passing'`, `'pending'`, `'unknown'`), so a check going green never leaves a stale item behind, and a flapping check never accumulates duplicates - it is always the one latest reading for that session.
  - The item carries what's needed to act on it: the session, the failing check run names (`failingChecks`), and the PR's own URL/number (`prUrl`/`prNumber`) so a renderer can link straight to it.
  - New `@loombox/shared` export `isFailingCiConclusion`: the same conservative "which GitHub check-run conclusions count as a failure" judgment the node's own `ci-check-watcher.ts` uses, now also available to the browser so it names the exact same failing check(s) rather than guessing independently.
  - `AttentionInbox.svelte` names the failing check(s) in the row body instead of a bare "CI check failed", and adds a "View PR" link for a `'ci_failure'` row. `'review_request'` remains the one still-unwired extension point (needs the tracker integration work, v2).

  Verified: `pnpm --filter @loombox/web exec vitest run src/lib/relay-client.test.ts src/lib/components/AttentionInbox.test.ts src/lib/components/pages/InboxPage.test.ts` (196 tests), `pnpm --filter @loombox/shared test` (24 tests), `pnpm --filter @loombox/web typecheck`, `pnpm --filter @loombox/shared typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

- 9400cb4: Local test runner joins the PR/CI loop and the attention inbox (SPEC §7.14/§7.15; issue #247)

  The runner (#245), the CI check watcher (#239), the auto-iterate loop (#246), and the inbox's `ci_failure` class (#243) existed as four separate pieces. This wires a local run into the exact same loop and the exact same inbox a remote CI result already uses, so a failing change tells one story regardless of which side observed it first.

  - New wire message `run_status` (`@loombox/protocol`'s `run-status.ts`): the node's own durable per-kind (`test`/`lint`/`build`) run outcome for a session, the runner's sibling of `ci_check_status` — node-pushed, session-scoped, envelope-sealed, aggregating to `'unknown'`/`'passing'`/`'failing'`. `@loombox/shared`'s new `isFailingRunOutcome` (a run's outcome is `'fail'`/`'could_not_start'`) is the runner's own `isFailingCiConclusion` sibling, shared between the node and the browser so both name the same runs as failing.
  - `@loombox/node`'s new `RunStatusTracker` (`run-status-tracker.ts`) is `NodeDaemon.executeRun`'s own latest-outcome memory, updated from every exit path (a policy denial, an unsafe run id, and a real `run_exit` alike) right alongside the existing `sendRunExit`, and pushed as `run_status`.
  - A failing run also drives `CiAutoIterateController` — the SAME controller/session record a CI failure already drives, sharing one attempt count/bound per session rather than two separate loops. The real risk this issue calls out: a CI failure and a local runner failure for the SAME underlying commit must not drive two agent turns. `@loombox/node`'s new `AutoIterateDriveGate` (`auto-iterate-drive-gate.ts`) is the shared cross-source dedup both `NodeDaemon.handleCiCheckFailure` and the new `driveAutoIterateFromRunFailure` consult before ever calling `ciAutoIterateController.onFailure`, keyed on the failing commit's own head sha (`@loombox/node`'s new `workspace-head.ts`'s `resolveWorkspaceHeadSha`, the runner's own `resolveSessionBranch` sibling) — whichever source observes a given sha first drives; the other's own failure for that identical sha still updates its own status/inbox item, it just never fires a second `promptSession` turn. The gate's lifetime is tied to the controller's own active-loop lifetime (cleared alongside `reset()`/`onGreen()`/`forget()`), never CI's own shorter-lived per-poll dedup.
  - `@loombox/web`'s `RelayClient.attentionInbox()` gets a new `'run_failure'` class — the exact sibling of `'ci_failure'` (same base `AttentionInboxItem` shape: `sessionId`/`sessionTitle`/`projectPath`/`nodeId`/`waitingSince`, plus its own `failingRuns` alongside `ci_failure`'s `failingChecks`/`prUrl`/`prNumber`), built from `run_status` the same "durable until it clears, never a second guess" way `ci_failure` is built from `ci_check_status`. Independent of `ci_failure`, `awaiting_input`, and `session_outcome`: a session can carry any combination at once. `AttentionInbox.svelte` renders it with its own `'Run'` badge.

  Verified:

  - `pnpm --filter @loombox/node exec vitest run src/workspace-head.test.ts src/auto-iterate-drive-gate.test.ts src/run-status-tracker.test.ts src/node-daemon-run-ci-loop.test.ts src/node-daemon-ci-auto-iterate.test.ts src/node-daemon-ci-check.test.ts src/node-daemon-test-runner.test.ts src/test-runner-process.test.ts src/test-runner-config-store.test.ts` (250 tests, real local `sh -c`/git subprocesses only, no real network)
  - `pnpm --filter @loombox/shared exec vitest run src/run-status.test.ts` (2 tests)
  - `pnpm exec vitest run apps/web/src/lib/relay-client.test.ts apps/web/src/lib/components/AttentionInbox.test.ts` (218 + 32 tests, real in-process relay only)
  - `pnpm --filter @loombox/protocol typecheck`, `pnpm --filter @loombox/shared typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/relay typecheck`, `pnpm --filter @loombox/web typecheck` — all clean
  - `pnpm exec eslint` on every changed/new file — no errors
  - the full `pnpm format:check` — clean
  - the full `pnpm test` (touched `@loombox/protocol`) — 445 files passed, 1 pre-existing unrelated skip, 5379 tests passed, 2 skipped, 0 failures

- e087fb9: Aggregate spend-over-time view, per project and per provider (SPEC §7.9; issue #249)

  `@loombox/node` persists a per-day/project/provider spend ledger (`SpendLedgerStore`), fed by the exact same `usage_update.costUsd` increase that already drives §7.16's spend-cap enforcement — one source, never two divergent cost computations. `@loombox/protocol` adds `spend_report_request`/`spend_report_response` (node-addressed by `nodeId`+`projectPath`, mirroring `tracker_snapshot_request`; the request itself carries no envelope since a date range is a query parameter, not project content), routed through `@loombox/relay`'s exhaustive message-routing table.

  The per-project/per-provider grouping logic (`aggregateSpendLedgerRows`/`filterSpendLedgerRows`) now lives in `@loombox/shared` rather than `@loombox/node`, so `@loombox/web`'s new `SpendReportPanel` (mounted in the Config workbench tab) reuses the identical function the node runs server-side, rather than recomputing the rollup a second time in the browser. The panel offers a 7d/30d/90d/all-time period selector and shows a total plus per-provider breakdown; a period with nothing recorded reads as an honest "No spend recorded for this period." message, never a fabricated $0.00, matching the live session cost meter's own established convention.

### Patch Changes

- Updated dependencies [7b8e591]
- Updated dependencies [edb3752]
- Updated dependencies [d2741e2]
- Updated dependencies [e42b8d1]
- Updated dependencies [8948531]
- Updated dependencies [3dcb133]
- Updated dependencies [93c1ffd]
- Updated dependencies [c8a9381]
- Updated dependencies [12cc8ec]
- Updated dependencies [9400cb4]
- Updated dependencies [eb16820]
- Updated dependencies [e087fb9]
- Updated dependencies [ed2392d]
  - @loombox/protocol@0.8.0

## 0.2.5

### Patch Changes

- Updated dependencies [584520e]
- Updated dependencies [a0fb0a6]
- Updated dependencies [0c46b48]
- Updated dependencies [8a3fcda]
- Updated dependencies [97598db]
- Updated dependencies [ff1fb1e]
- Updated dependencies [7ad7274]
- Updated dependencies [79f55e0]
- Updated dependencies [6d3ad95]
- Updated dependencies [6325366]
- Updated dependencies [d03fc5d]
- Updated dependencies [166551b]
- Updated dependencies [757fa0e]
- Updated dependencies [dace883]
- Updated dependencies [89355b1]
- Updated dependencies [109184d]
- Updated dependencies [4cc52b4]
- Updated dependencies [4291dc3]
  - @loombox/protocol@0.7.0

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
