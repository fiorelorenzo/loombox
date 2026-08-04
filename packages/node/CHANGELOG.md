# @loombox/node

## 0.3.0

### Minor Changes

- 535a2ee: Add the SPEC §7.26 connect/disconnect/pin wire protocol, relay routing, node handlers, and `RelayClient` API for connected accounts (issue #230)

  New `@loombox/protocol` message pairs: `github_connect_start_request`/`_cancel_request`/`_device_code`/`_result` (RFC 8628 device flow, issue #222), `jira_connect_request`/`_response` (API-token connect, issue #225), `connected_account_disconnect_request`/`_response`, and `account_pin_get/set/unset_request` + `account_pin_response` + `account_pin_resolve_request`/`_response` (per-project, per-capability pinning and hard-fail preview, issue #227). None of these ever carry a token, API key, or other secret — only metadata and routing fields.

  `packages/relay`: routes every one of the above directly by `nodeId`, scoped to the requester's account, through one consolidated `pendingAccountRequests` table (mirrors the existing `provision_target_request`/`ssh_discovery_request` pattern); a successful disconnect also forgets the account's synced metadata row (`ConnectedAccountStore.remove`, new on the store interface, in-memory and Postgres).

  `packages/node`: `NodeDaemon` now runs `GithubConnectService`/`JiraConnectService`/`AccountPinStore`/`account-pin.ts`'s resolvers against these messages — the device flow's user code streams back before the terminal result, a disconnect deletes the local keyring secret, and pin resolution surfaces `AccountPinRequiredError`/`AccountPinMalformedError`/`AccountHostMismatchError`/`AccountPinDanglingError`/`AmbiguousAccountError` as real, distinguishable response states.

  `apps/web`'s `RelayClient` gains a `connectedAccounts` reactive store (fed by the existing `connected_account_list` snapshot) plus `startGithubConnect`/`connectJiraAccount`/`disconnectAccount`/`getAccountPins`/`setAccountPin`/`unsetAccountPin`/`resolveAccountPin`/`refreshConnectedAccounts` — the write-path client API #230's UI is built against.

  **Scope note**: this change ships the wire protocol, relay routing, node handlers, and client API only. The Svelte UI itself (a Settings "Accounts" section, the device-flow/API-token connect forms, the per-project pin picker, and the disconnect confirmation) is tracked separately — see issue #230's own thread for the remaining UI work.

- e89b263: Add GitHub `TrackerBackend` transitions, live tracker slice 2 (SPEC §7.10, issue #215)

  `GithubTrackerBackend` now implements `listTransitions`/`transition`, GitHub's fixed two-state model rather than a discovered per-project workflow: `listTransitions` reports `close_completed`/`close_not_planned` when the issue is currently open, and `reopen` when it is closed, by reading the issue's current `state` first. `transition` applies one of those by `PATCH .../issues/{n} {state, state_reason}` (SPEC §7.10), so closing as completed and closing as not planned are distinct, inspectable outcomes end to end — a subsequent read reports the applied `fields.stateReason`, never a bare "closed". An unknown `transitionId` is rejected with `GithubTrackerAccessError` before any request is made.

  `capabilities.transitions` flips to `true`; `boards`/`sprints` are unchanged (still `false`, deferred to #218). Slice 1's `list`/`get`/`create`/`update`/`addComment`/`listBindings` behaviour is untouched.

- a006a1e: Add the Jira API-token connect path (SPEC §7.26, issue #225)

  `@loombox/node` gets the zero-infrastructure Jira connect path: `JiraConnectService` (`jira-connect.ts`) takes `{siteUrl, email, apiToken}`, resolves identity via `GET /rest/api/3/myself` over Basic auth (`base64(email:apiToken)`, `jira-identity.ts`'s `resolveJiraIdentity`), and returns the metadata-only `ConnectedAccount` (issue #221) keyed on `(siteUrl-host, accountId)` — the stable Atlassian `accountId`, never the mutable `email`. This is the specific fix for emdash's `jira-connection-service.ts` single-row limitation (keyed on `email`, one row total): connecting a second Jira site, or a second account on the same site, gets its own `ConnectedAccount.id` and never overwrites an existing one.

  `credentialSource` is `'api_token'`. The email/apiToken pair lives only in the node's OS keyring (`keyring.ts`'s `NodeKeyring`, the same abstraction and file-fallback #222's `GithubConnectService` uses) — Basic auth needs both on every request, and `email` is deliberately not a `ConnectedAccount` field, so it travels with the token as one keyring secret rather than living on the synced row. `getCredential` resolves a `ConnectedAccount` into the request base URL and a ready-to-set `Authorization` header — the seam #214's `JiraTrackerBackend` consumes, agreed over IRC while both issues were in flight.

  No Jira OAuth 2.0 (3LO, #226), per-project pinning (#227, already shipped and reusable as-is), node-presence computation (#228), or connect-flow UI (#230) ship here.

- a3c21b7: Add the Jira `TrackerBackend`, live tracker slice 1 (SPEC §7.10, issue #214)

  `@loombox/node` gets `JiraTrackerBackend` (`jira-tracker-backend.ts`), the second concrete implementation of `@loombox/shared`'s `TrackerBackend` extension point (#209), after GitHub (#213). `list`/`get`/`create`/`update`/`addComment`/`listBindings` go against Jira Cloud REST v3 for a bound project: `list` searches via `POST /rest/api/3/search/jql` (the modern token-paginated replacement for the deprecated `search` endpoint), comment bodies and any `description` field are converted from plain text into a minimal `{type:'doc', version:1, content:[...]}` Atlassian Document Format document (and flattened back to plain text on read), and every request is composed purely from an injected `credential.baseUrl`, so the same backend works unmodified against both an OAuth-3LO-routed base (`https://api.atlassian.com/ex/jira/{cloudId}`) and a direct API-token site host. `create`/`update` each follow up with a `get` since Jira's own create/update responses don't carry the full issue (`{id, key, self}` only, and `204 No Content`, respectively).

  Credentials come only from an injected `resolveCredential(connectionId): Promise<{baseUrl, authHeader}>`; this backend never runs a connect flow and never touches this package's own `keyring.ts`/`jira-connect.ts` directly.

  `capabilities` reports `comments`/`labels: true`, `transitions`/`boards`/`sprints`/`milestones`/`customFields: false` for this slice. No transitions (#216), no boards/sprints (#217) ship here.

- 2592c10: Add Jira `TrackerBackend` workflow transitions, live tracker slice 2 (SPEC §7.10, issue #216)

  `JiraTrackerBackend` now implements `listTransitions`/`transition` by discovering Jira's real, per-project/per-issue-type workflow at runtime instead of assuming a fixed set: `listTransitions` calls `GET .../issue/{key}/transitions` and maps each entry to `{id, name, requiresFields}`, where `requiresFields` is read straight off Jira's own per-transition workflow-screen field map (`required: true`) — most commonly seen on a "Done"-category move that needs a `resolution`. `transition` posts the chosen id via `POST .../issue/{key}/transitions` and accepts an optional fourth argument (`options.fields`/`options.comment`) beyond `TrackerBackend.transition`'s own three-parameter shape, so a Jira-aware caller can supply what a field-requiring move needs; `options.comment` is converted to Atlassian Document Format the same way `addComment` does, sent as `update.comment`. If Jira's own workflow validation still rejects the request over a missing required field, that surfaces as a new typed `JiraTrackerTransitionValidationError` (carrying Jira's per-field messages) — never silently dropped, and never reported as a success.

  `capabilities.transitions` flips to `true`; `boards`/`sprints` are unchanged (still `false`, deferred to #217). Slice 1's `list`/`get`/`create`/`update`/`addComment`/`listBindings` behaviour is untouched, both REST bases (OAuth 3LO `api.atlassian.com/ex/jira/{cloudId}` and direct-site API-token) are exercised for the new calls, and `@loombox/shared`'s `TrackerTransition` gets a new optional `requiresFields` field (GitHub's already-shipped fixed two-state transitions never set it).

- 99e3583: Native tracker: kanban/list UI with custom type support (SPEC §7.10)

  Adds the client surface for loombox's own local tracker (`packages/shared`'s `NativeTrackerStore`, #210): a full-width Tracker page reachable from the left sidebar once a session is selected, with a kanban board and a priority-sorted/assignee-filtered list view, both driven entirely by `@loombox/protocol`'s new role-driven helpers (`resolveRoleValue`/`groupByWorkflowStatus`/`sortByPriority`/`filterByAssignee`) so a built-in Task/Bug/Epic and a project-defined custom type render identically — nothing in this feature branches on a record's `primaryType`.

  `@loombox/protocol` gets `tracker-records.ts`: the wire schema (`TrackerRecordV1`/`TrackerTypeDefinitionV1`) plus four new encrypted, session-scoped wire messages — `tracker_snapshot_request`/`_response` (read) and `tracker_write_request`/`_response` (create/update/defineType) — mirroring `fs.ts`'s existing pattern exactly. `@loombox/node` wires these into `NodeDaemon` against the same `NativeTrackerStore` a future MCP host will bind an agent's `tracker_*` tools to, so a human edit and an agent write land in the same on-disk file. `@loombox/relay` routes both pairs to/from the owning node exactly like `fs_list_request`/`_response`.

  The UI ships: empty state with a "New record" CTA, a retryable `ErrorNotice` (matching the Files panel's #582 "didn't answer in time" wording) for both a wire error and a client-owned bounded-wait timeout, and a loading state that always terminates. The kanban board answers issue #212's mobile requirement directly: at <=767px it renders one column at a time with Prev/Next controls instead of a horizontal scroll of narrow columns. Moving a card between columns has two paths — native HTML5 drag-and-drop for a desktop mouse, and a fully keyboard/touch-operable "Move to" `Select` on every card — both calling the same `RelayClient.updateTrackerRecord`, never local component state. A "New type" dialog lets a project define a custom type's `roles` mapping (which `fields` key holds title/status/priority/assignee), after which every generic surface renders it correctly with no code change.

- 7fc92d2: Add the native tracker's MCP tool contract (SPEC §7.10, §7.7)

  `@loombox/node` gets `tracker-mcp-tools.ts`: `createTrackerMcpTools`, which builds `tracker_list`/`tracker_get`/`tracker_create`/`tracker_update`/`tracker_link_session` — the five tools SPEC §7.10 names for agent access to the native tracker — from a `NativeTrackerStore` plus a session's already-resolved `(projectPath, authorId, sessionId)`. Every input schema is a `.strict()` Zod object with no `projectPath`/`authorId`/`sessionId` field, so a session's tools are structurally bound to its own project and identity rather than merely checked against them; a call naming another project's record id fails exactly like a call naming a made-up one. Output is the real `TrackerRecord` (`fields`/`system`/indexed columns from #210's data model), with no ad-hoc DTO.

  No node-side MCP host consumes this yet — this repo's whole MCP surface today only lets a session declare an _external_ MCP server (stdio/http/sse) that the ACP agent connects to itself; there is no mechanism to run an MCP server inside the node and serve tool calls from it. That's a distinct, larger piece of work, filed as a follow-up issue rather than faked here.

- 344b4c7: Add the lazy per-node connected-account presence check (SPEC §7.26 "Node-locality", issue #228)

  `NodeAccountPresence` (`account-presence.ts`) answers "does this node's OS keyring currently hold a connected account's credential" — the local half of SPEC §7.26's node-locality gap: a `ConnectedAccount`'s metadata row syncs through the relay, but its secret lives in one node's keyring, so a second node can see the account and still not be able to use it. The check is computed lazily (never eagerly probed at startup) and cached per `secretRef` in memory; a connect or disconnect on this node invalidates the cached answer via a new `onCredentialChanged` hook both `GithubConnectService` and `JiraConnectService` now call. `isPresent` returns only a boolean — the credential value never leaves the keyring read that produces it.

  `GithubConnectService` and `JiraConnectService` previously each built their own private `NodeKeyring` (same service name, different file-fallback filename). Extracted into `connected-account-keyring.ts`'s `createConnectedAccountKeyring`, which both connect services and `NodeAccountPresence` now share — necessary for correctness, not just DRY: on this devbox's file-fallback path (no OS keyring session), a presence check built from its own independent file would silently report every real account absent.

  `account-pin.ts` (#227) gains `resolveAccountForWriteOnThisNode`, layered on top of the existing `resolveAccountForWrite` (unchanged, same hard-fail cases, same tests green) — throws the new `AccountNotPresentOnNodeError` when the resolved account is not present on this node, a distinct outcome from "no pin" (`AccountPinRequiredError`) and "dangling pin" (`AccountPinDanglingError`).

  Not shipped here: the multi-node wire/UI flow that asks a _different_ node whether it holds a pin's secret (SPEC §7.26 frames that as reusing §7.21's node-health reachability channel) — this issue is scoped to the local, per-node computation only.

- e05423a: Add per-project test/lint/build command configuration and auto-detection (SPEC §7.15, issue #245)

  A project's test/lint/build commands can now be read, saved, and auto-detected through the owning node: `TestRunnerConfigStore` (`@loombox/node`) persists them per project (mirrors `PermissionPolicyStore`'s JSON-file shape), and `detectTestRunnerCommands` proposes commands from `package.json`'s `scripts` block via whichever `ExecutionTarget` the project's session runs on (`local` or `ssh:`), picking `pnpm`/`yarn`/`npm` syntax off the project's lockfile. Detection only ever proposes a command for a script that genuinely exists — never a guessed default for a project with nothing detectable.

  Five new v1 wire messages (`test_runner_config_get`/`_set`/`_detect` client-to-node, `test_runner_config_result`/`_detected` node-to-client), routed/fanned out by the relay exactly like `fs_list_request`/`fs_list_response`, sealed under the session key so no command string ever reaches the relay in the clear. `RelayClient` gains `getTestRunnerConfig`/`setTestRunnerConfig`/`detectTestRunnerConfig`; `ProjectConfigPanel` gains a new "Test, lint & build" section (`TestRunnerConfigPanel`) with per-command explicit save and an "Auto-detect" action whose suggestions are shown for confirmation and never applied without an explicit Accept click.

  This ships the configuration half of SPEC §7.15's test runner (issue #245); the streaming execution half (issue #244, running the configured commands with live output and cancellation) is tracked separately.

- 635e20d: Add the streaming test/lint/build runner surface (SPEC §7.15, issue #244)

  Running a project's configured test/lint/build command (issue #245's config half) now streams live results from the cockpit instead of requiring a raw terminal. `packages/node/src/test-runner-process.ts` runs the command via `sh -c` on either target: locally with `child_process.spawn({ detached: true })`, so a cancel kills the whole process group (`process.kill(-pid, 'SIGKILL')`), not just the launcher; over `ssh:` it reuses the existing `RemoteProcessRunner` (setsid+fifo+log-tail) rather than opening a second channel, adding its own exit-code side-channel on top since that runner never captured one for a background job, and its cancel goes through `RemoteProcessRunner.stop()`, whose `setsid` branch now kills the whole remote process group (issue #642/#645). Both targets classify "command not found" as a uniform POSIX 127 instead of branching on ENOENT vs. remote shell text. `NodeDaemon` evaluates the project's permission policy (`evaluateCommandLine`, the same entry point `PolicyEnforcedPty`/`PolicyEnforcedExecutionTarget` use) before ever spawning, so a denied command surfaces as `could_not_start` with a policy reason and never runs.

  Five new v1 wire messages (`run_start`/`run_cancel` client-to-node, `run_started`/`run_output`/`run_exit` node-to-client), modeled on `terminal.ts`, routed/fanned out by the relay exactly like `terminal_open`/`terminal_output`, sealed under the session key so no command, output, or outcome ever reaches the relay in the clear. `RelayClient` gains `startRun`/`cancelRun`/`onRunOutput`/`runsFor`. The right sidebar's Files/Config sub-tabs gain a third "Runner" tab (`RunnerPanel.svelte`): one Run/Cancel action per configured command, its combined output streaming live (reusing the display-only `TerminalOutput` component), settling to a pass/fail/could-not-start state with the real exit code.

  Cancelling reaps the whole process tree on both targets, including forked grandchildren — verified with a `sleep 30 &`-forking fixture at the process, `NodeDaemon`, and (ssh) `RemoteProcessRunner` layers. Closing a node now also cancels every still-running local/ssh run instead of leaking it, the same way it already does for open terminals.

### Patch Changes

- 934301d: Fix `buildStopScript`'s `setsid` branch to kill the whole process group, not just the launcher (issue #642)

  Stopping an `ssh:` session that had fallen back to `setsid` (the common case on a plain server without tmux/screen) ran `kill "$(cat pid)"`, which signals exactly one process. `setsid` makes the launched process a session leader, so its pid is also its process-group id, and anything real it launches (any agent or command that forks children) kept running on the remote host after "stop" returned. The `tmux`/`screen` branches never had this problem since they tear the whole session down.

  `buildStopScript`'s `setsid` branch now sends `TERM` to the process group (`kill -TERM -"$pid"`, the leading dash), polls for up to 2 seconds so a well-behaved child gets a chance to clean up, then escalates to `KILL -"$pid"` for anything still alive. `buildIsRunningScript` is unchanged (it still reads the leader's own pid with `kill -0`), and stays correct because the stop script itself blocks until the group is confirmed dead or force-killed before its `exec()` resolves, so there is no window where a caller can observe a stopped session as still "alive".

  New tests in `packages/node/src/ssh/remote-process-runner.test.ts` (using the `remote-sessions-test-sandbox` harness from #518) launch a `setsid` command that forks a real child, stop the session, and assert the child itself is gone (not just the launcher), plus confirm `isRunning()` still reports correctly across the new stop script.

- Updated dependencies [79f9f19]
- Updated dependencies [535a2ee]
- Updated dependencies [2592c10]
- Updated dependencies [99e3583]
- Updated dependencies [e05423a]
- Updated dependencies [635e20d]
- Updated dependencies [29da402]
  - @loombox/providers-core@0.3.0
  - @loombox/protocol@0.3.0
  - @loombox/shared@0.2.0
  - @loombox/supervisor@0.1.2
  - @loombox/crypto@0.0.3

## 0.2.0

### Minor Changes

- c907512: Add per-project, per-capability connected-account pin resolution (SPEC §7.26, issue #227)

  `@loombox/node` gets `account-pin.ts`: a pure resolver over the tri-state `AccountPinMap` from SPEC §7.26 (`{ github?: string | null; jira?: string | null; [capability]: string | null | undefined }`) — an absent key means unconfigured, an explicit `null` means opted out, a string is a pinned `ConnectedAccount.id`. `resolveAccountForRead` and `resolveAccountForWrite` are two distinct functions (not one function plus a flag) so a caller cannot forget the difference: a write-back action always throws `AccountPinRequiredError` without an explicit pin, while a read may default silently only when exactly one candidate account matches, throwing `AmbiguousAccountError` for two or more. Both hard-fail with `AccountHostMismatchError` when a pinned account's decoded host/site (via `@loombox/protocol`'s `parseConnectedAccountId`, never string-slicing) doesn't match the project's configured target, mirroring emdash's `githubApiAccountHostMismatch` guard — never a silent fallback to a different account. `AccountPinDanglingError`/`AccountPinMalformedError` cover a pin naming an unknown or unparsable id.

  `account-pin-store.ts` persists the map node-side as one JSON file keyed by `projectPath`, mirroring `permission-policy-store.ts`/`mcp-config-store.ts`'s existing per-project storage shape. `setPin`/`unsetPin` are deliberately separate operations (an explicit `null` opt-out vs. deleting the key back to unconfigured) so the tri-state survives a save/reload round trip intact.

  No tracker backend, no wiring into a write-back call site, no management UI (#230), no safe-disconnect scan (#229), and no node-presence computation (#228) ship here — this is the resolution primitive those build on.

- ac64679: Add the GitHub connect device flow (SPEC §7.26, issue #222)

  `@loombox/node` gets the default GitHub connect path: `runGithubDeviceFlow` (`github-device-flow.ts`) runs RFC 8628's device authorization grant against `github.com` with a public OAuth App client id only (no client secret shipped or required — configurable per deployment via `LOOMBOX_GITHUB_CONNECT_CLIENT_ID`, `github-connect.ts`'s `resolveGithubConnectClientId`), requesting exactly `repo read:user read:org read:project`. It handles every real poll state — `authorization_pending` keeps polling at the server-given `interval`, `slow_down` increases it (honoring an explicit server `interval` or GitHub's documented +5s default), `expired_token`/`access_denied` end the flow with a named `GithubDeviceFlowError`, and an `AbortSignal` cancels it immediately rather than waiting out the current interval.

  `resolveGithubIdentity` (`github-identity.ts`) resolves `GET /user` and rejects any response with no numeric `id` — never falls back to `login`. `GithubConnectService` (`github-connect.ts`) orchestrates both, writes the resulting token to this node's OS keyring (`keyring.ts`'s `NodeKeyring`, same abstraction and file-fallback as `mcp-secrets.ts`), and returns the metadata-only `ConnectedAccount` (issue #221) a caller announces through the existing `connected_account_announce` wire path — the token never appears in that returned value, in a log line, or in any error message.

  No `gh` CLI import (#223), PAT paste (#224), Jira paths (#225, #226), per-project pinning (#227), node-presence computation (#228), or management UI (#230) ship here.

- aad37f8: Add the GitHub `TrackerBackend`, live tracker slice 1 (SPEC §7.10, issue #213)

  `@loombox/node` gets `GithubTrackerBackend` (`github-tracker-backend.ts`), the first concrete implementation of `@loombox/shared`'s `TrackerBackend` extension point (#209). `list`/`get`/`create`/`update`/`addComment`/`listBindings` all go straight to GitHub REST (`docs.github.com/en/rest/issues/*`) for a bound `owner/repo`: `list` paginates via the `Link` header's `rel="next"` (carried opaquely through `TrackerListFilter.cursor`/`TrackerListPage.nextCursor`), a `403` with `x-ratelimit-remaining: 0` raises a distinct `GithubTrackerRateLimitError` with a computed `retryAfterMs` instead of being reported as a permission problem, a `404` raises `GithubTrackerAccessError` (GitHub returns 404, not 403, for a token with no access to a private repo/issue), and pull requests — which GitHub's issues endpoints return alongside real issues — are filtered out of `list` and rejected explicitly from `get`.

  Credentials come only from an injected `resolveCredential(connectionId): Promise<{token}>`; this backend never runs OAuth and never touches this package's own `keyring.ts`/`github-connect.ts` directly, since the real connected-accounts credential registry SPEC §7.10 describes doesn't exist in a directly callable shape yet.

  `capabilities` reports `comments`/`labels`/`milestones: true`, `transitions`/`boards`/`sprints`/`customFields: false` for this slice. No transitions (#215), no boards/Projects v2 (#218), no Jira backend (#214) ship here. Server-side only: this lives in `@loombox/node`, which is not in `apps/web`'s dependency graph, direct or transitive.

- 804933f: Add the native tracker's `TrackerRecord` data model and node-side storage (SPEC §7.10 "Native mode")

  `@loombox/shared` gets `tracker-record.ts`: `TrackerRecord` (a `fields` business-data bag, a `system` object holding author/linked commits/PRs/sessions/activity/comments, and real queryable columns — `id`/`primaryType`/`typeTags`/`issueNumber`/`archived`/`createdAt`/`updatedAt` — around both), `TrackerTypeDefinition` with a `roles` mapping (`title`/`workflowStatus`/`priority`/`assignee`), the three built-in types (Task/Bug/Epic), and `resolveRoleValue`/`groupByWorkflowStatus`/`sortByPriority`/`filterByAssignee`, the role-driven query helpers that make a kanban board, priority sort, and assignee filter work identically whether a record's type is built-in or project-defined. `buildTrackerIndex` builds the in-memory secondary indexes (by id/issue number/primary type/tag, plus active/archived partitions) a non-SQL store needs for real lookups. No `syncStatus`/team-sync field exists anywhere in this shape, enforced by both a compile-time type guard and a runtime test — the native tracker is per-operator by design (SPEC §7.10).

  `@loombox/node` gets `NativeTrackerStore`: a single JSON file per node (mirroring `SessionStore`/`McpConfigStore`'s established shape), keyed by project path, holding each project's custom type definitions and tracker records. This follows the node's existing persistence idiom deliberately rather than introducing a new SQL dependency: every store this package already has is a JSON file, the one SQL engine in the monorepo (`better-sqlite3`) is only ever a Postgres test double for the relay's Better Auth tables, and a native tracker's per-operator, single-writer data doesn't need the relational query planning a real database buys. `create`/`get`/`update`/`list`/`defineType`/`linkSession`/`linkCommit`/`linkPullRequest`/`addComment` round-trip both built-in and custom-type records; `index()` exposes the store's current secondary indexes.

  No consumer wires this into the MCP tool contract or a UI yet — that's issues #211 and #212.

- fa0dbd1: Add a per-project permission policy (SPEC §7.17): allow/deny glob rules matched against the command an agent's process runs and the network destination it reaches, enforced at the node rather than relying on ACP's own agent-discretionary `session/request_permission`.

  Deny always wins over allow; a project's saved policy lives in `PermissionPolicyStore` (`~/.loombox/node/permission-policy.json`, no settings UI yet); an unconfigured project keeps today's behavior (nothing blocked).

  Enforced today at every interactive terminal this node opens (`PolicyEnforcedPty`, local and `ssh:` alike): a denied line is never forwarded to the real shell, the pending input is cleared, and a rejection is written back into that terminal's own output. Also wired into `NodeDaemon.getExecutionTarget()`'s exec seam (`PolicyEnforcedExecutionTarget`) for the project-scoped commands a future editor/git-management feature will drive through it — nothing project-scoped calls that seam yet, so this is not a live gate today beyond the terminal.

  Not covered: an agent's own in-process tool calls (Claude Code/Codex run their own bash tool internally; this node declares `clientCapabilities.terminal: false` to ACP, so it never sees those individual commands) — that gap is namespace/bind-mount sandboxing's job (issue #257). Also named, not closed: `sudo`/`nice`/`ionice` command-prefix unwrapping, and `ssh:`-target symlink resolution.

- a449b22: Add per-target concurrency caps with a FIFO overflow queue (SPEC §7.16)

  `@loombox/node` gets a `SessionConcurrencyGate` (`session-concurrency-gate.ts`), the one chokepoint every session's launch — `local` and `ssh:` alike — passes through in `NodeDaemon.createSessionInternal`/`scheduleSshSession`. Starting a session beyond its target's configured cap queues it (wire status `'queued'`, distinct from the existing `'starting'`) instead of launching it; a session that finishes, crashes, is killed, or is stopped (`session_archive_request`) releases its slot and hands it to the oldest still-queued session on that target, FIFO. A queued session can be cancelled (also via `session_archive_request`) and never launches. Lowering a target's cap never kills sessions already running past the new limit, it only gates future starts.

  The default cap differs by target kind, since their known resources differ: `local` defaults to this host's own CPU core count (`os.cpus().length`, the same source `resource-sampler.ts` already reads), while an `ssh:` target defaults to a conservative `2` (its real capacity is unknown until an operator sets `SshTargetConfig.maxConcurrentSessions` or turns on resource sampling). `local`'s own cap is configurable via `NodeDaemonOptions.localMaxConcurrentSessions` / `LOOMBOX_LOCAL_MAX_CONCURRENT_SESSIONS` / the config file's `localMaxConcurrentSessions`.

  `@loombox/protocol` widens `sessionStatusV1` with `'queued'`, alongside the existing `'starting'` — both synthesized by the node rather than passed through from the agent process. This is an additive enum change: an older peer simply drops a `session_status` envelope carrying a value it doesn't recognize.

  Also fixes a real bug found while building this: `NodeDaemon.close()`/the new per-session stop path called `AgentSupervisor.stop()` with the loombox-level session id, but the supervisor keys its sessions by the ACP-level id the agent's own `session/new` response assigns — the wrong key meant `.stop()` never actually found the session, so the child agent process was never killed, only reaped incidentally when the whole node process exited.

### Patch Changes

- Updated dependencies [5118b26]
- Updated dependencies [804933f]
- Updated dependencies [a449b22]
- Updated dependencies [d09e12b]
- Updated dependencies [c97a2cf]
- Updated dependencies [fc2c12e]
  - @loombox/protocol@0.2.0
  - @loombox/shared@0.1.0
  - @loombox/providers-core@0.2.0
  - @loombox/crypto@0.0.2
  - @loombox/supervisor@0.1.1

## 0.1.0

### Minor Changes

- c0d6291: Make projects real, and give the cockpit one navigation instead of two.

  `Project` is now a first-class thing in the client rather than a `projectPath` string buried in each session's encrypted envelope, so you pick a folder once and spawn sessions into it. Sessions are listed in a tree under their project, and Inbox, Nodes and Settings became pages in the main area instead of drawer tabs that the sidebar also linked to. The drawer keeps only what belongs to the open session: Files, Terminal, Config.

  On the wire, a session's private envelope gains an optional `worktree` field, which is SPEC 7.1's per-session isolate-or-work-in-place choice finally reaching the client, and the target fs listing gains an optional `gitRepo` flag so the picker knows whether to offer it. Both are additive, so a node or client older than its peer keeps parsing. The node also stops requiring a git repository for in-place sessions, which SPEC 6 has always said it should support.

- c86aa72: Survive a node restart, bound the agent spawn, and make the surface coherent

  A node restart no longer forgets every session it owns, so rows stop pointing at sessions nobody tracks and worktrees stop leaking. The agent spawn is bounded, and a session is announced as soon as its worktree exists rather than only once the agent is up.

  The node status numbers were wrong: CPU was a load average mislabelled as utilisation, and RAM counted reclaimable page cache as used. Both fixed, and the reading now carries the machine's hostname, platform and arch so a target called "Local" says which machine it is.

  On the client: one page title instead of two, one Settings entry instead of three, a real form language instead of eight copies of the same hand-rolled input, dense node rows instead of three progress bars, and a transcript that states who is speaking with a composer that is part of it rather than a chat box bolted underneath.

- 8f305d0: Survive a relay restart, follow the agent, and let a session be archived.

  A relay redeploy used to brick every node until someone restarted it by hand: a
  peer built on the WHATWG WebSocket cannot send a transport-level ping, so nodes
  and clients now probe liveness with a `ping`/`pong` pair the relay answers and
  advertises as a `heartbeat` capability, and both reconnect with backoff from a
  single handler wired to close _and_ error.

  The transcript now follows the agent's newest output instead of sitting pinned
  at the first frame, detaching when you scroll up to read.

  Sessions can be archived from the row menu, optionally taking their git
  worktree and branch with them, so a project stops accumulating one worktree per
  session that nobody would ever prune by hand.

- fcb76fc: Offer the agents a target can actually run, and fix what the forms ask. Nodes now probe each target's own PATH and announce which providers work there, so the agent picker is a real choice instead of a hardcoded one-option dropdown. Adds Codex and Oh My Pi as real providers alongside Claude Code. The new-session dialog leads with the starting prompt, no longer reshapes itself ten seconds after opening, and every form marks the one required field instead of labelling the four optional ones.

### Patch Changes

- 4f7dcd4: Actually wire the per-target provider probe. `main.ts` never passed `providerCandidates`, which defaults to an empty list and makes the probe a documented no-op, so every production target announced `providers: []` and clients correctly refused to create sessions on it. The candidate list now comes from `AgentSupervisor`'s own default provider set (`DEFAULT_PROVIDER_REQUIREMENTS`), so the advertised set and the spawnable set cannot drift.
- 10df3db: Let a resident node resolve its own account from the token it actually holds.

  A node that linked itself the intended way, through the device-authorization
  flow (it prints a short code, you approve it in the browser, it persists the
  token it mints), then died on startup with "authToken (LOOMBOX_AUTH_TOKEN) is
  not a valid, active Better Auth session". It was holding a token the relay
  accepted on the WebSocket handshake seconds later: the node asked Better Auth's
  `/api/auth/get-session`, which only knows browser sessions, while a device
  token lives in the relay's own `device_tokens`. The only way through was
  setting `LOOMBOX_ACCOUNT_ID` by hand, which defeats the point of the flow.

  The relay now answers the question itself, via `GET /account`, using the same
  `resolveAccountId` the WS handshake uses, so device tokens, Better Auth
  sessions and the no-Postgres dev stub all resolve identically. The node asks
  that endpoint, and falls back to the old Better Auth lookup only when a relay
  is too old to have the route, since self-hosters upgrade relay and node
  independently.

- 3705e0b: Stop tests writing into the developer's real node state directory. `defaultNodeStateDir()` now throws under Vitest, so a test that forgets to inject a `stateDir` fails at the first call instead of corrupting `~/.loombox/node`. Session persistence made that omission destructive: six test files had already left 35 phantom session records in mine, which a real node reloads on boot.
- Updated dependencies [c0d6291]
- Updated dependencies [4f7dcd4]
- Updated dependencies [c86aa72]
- Updated dependencies [8f305d0]
- Updated dependencies [55161ed]
- Updated dependencies [a36e07a]
- Updated dependencies [fcb76fc]
  - @loombox/protocol@0.1.0
  - @loombox/supervisor@0.1.0
  - @loombox/providers-core@0.1.0
  - @loombox/crypto@0.0.1
