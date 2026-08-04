# @loombox/protocol

## 0.5.0

### Minor Changes

- a1038bf: Dispatch the tracker bridge on a project's mode, closing #631's own last gap (SPEC §7.10, §7.26)

  The node now carries a connected-account registry of its own (`connected_account_list_request`, requested on every fresh relay connection alongside `amk_epoch_fetch_request`, mirroring how a client already does this on `attemptOpen()`), and the relay answers it for a node connection exactly like it already does for a client one — the "one open question" #631's plan left open, confirmed and closed.

  `NodeDaemon.readTrackerSnapshotForBridge`/`applyTrackerWriteForBridge` — previously the last unwired piece of #214/#215/#220, both merged and unreachable — now dispatch through one shared `resolveTrackerDispatch(projectPath, intent)` seam: `{kind:'native'}` behaves exactly as before (proven by the existing native tracker test suite passing untouched), `{kind:'live'}` resolves through `resolveTrackerBackend` and reaches the real `GithubTrackerBackend`/`JiraTrackerBackend`, and an unresolvable mode returns a typed error rather than ever falling back to the local native store. Reading and writing thread `intent:'read'`/`intent:'write'` through that one shared resolver — the only place the two bridge paths are allowed to differ — so they cannot resolve a project to two different tracker accounts.

  `tracker-live-bridge.ts` (new) maps a live `TrackerItemLive` into the native tracker's own `TrackerRecordV1`/`TrackerTypeDefinitionV1` wire shape (only `title`/`workflowStatus` roles are mapped — the two the board actually needs to render and categorize), so the kanban/list views and issue #651's workflow-category grouping need no live-specific rendering path at all.

  `trackerSnapshotErrorV1`/`trackerWriteErrorV1` gain an optional structured `reason: TrackerBackendResolutionErrorV1` (a wire mirror of `resolveTrackerBackend`'s own 10-member error union) alongside the existing plain `message` — checked against the existing shapes first per #631's own instruction, and widened only because a bare string cannot let a client switch on `kind`. The Tracker page's `.tracker-live-gap-note` (added by #672 to name this exact gap) is gone, replaced by a real connectivity-error state: `ErrorNotice` plus a reason-specific `Badge` (mirroring `AccountPinPicker.svelte`'s identical per-kind-badge convention).

  **Proven live now, end to end through a real relay with a stubbed GitHub API:** live-mode read (`list`) and write (`update`), read/write resolving to the identical account, and the `accountNotConnected`/`credentialUnavailable` error cases — including a read against a project with a real, on-disk native record, proving the failure never falls back to it. **Still fixture-only:** Jira live coverage beyond `resolveTrackerBackend`'s own suite, `create`/`transition`/board-drag write-back (Jira transition discovery and GitHub's state-field translation are slice-2 work, not this issue's scope), and pagination past a live snapshot's first page (the bridge's wire schema carries no cursor).

## 0.4.0

### Minor Changes

- ebcf227: Terminal dock: the terminal's own card and duplicated "Terminal" titlebar are gone (issue #669, design spec §4 D1-2/D2-2). One thin bar remains at the top of the dock, carrying live connection status, the session's real working directory, the shell running the active PTY, and a new-tab control that opens genuinely additional terminals for the same session, each kept alive when you switch away from it. `cwd`/`shell` are real values reported by the node (`terminal_opened`'s payload gained these two fields) — never guessed client-side.

  The dock itself moved to `--color-rail` and dropped its hairline border against the canvas, so the seam is a colour step instead of a line; the resize handle stays discoverable on hover and still works from the keyboard.

### Patch Changes

- 7606627: Group the tracker kanban board into three fixed workflow-category columns instead of one column per raw status

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

## 0.3.0

### Minor Changes

- 535a2ee: Add the SPEC §7.26 connect/disconnect/pin wire protocol, relay routing, node handlers, and `RelayClient` API for connected accounts (issue #230)

  New `@loombox/protocol` message pairs: `github_connect_start_request`/`_cancel_request`/`_device_code`/`_result` (RFC 8628 device flow, issue #222), `jira_connect_request`/`_response` (API-token connect, issue #225), `connected_account_disconnect_request`/`_response`, and `account_pin_get/set/unset_request` + `account_pin_response` + `account_pin_resolve_request`/`_response` (per-project, per-capability pinning and hard-fail preview, issue #227). None of these ever carry a token, API key, or other secret — only metadata and routing fields.

  `packages/relay`: routes every one of the above directly by `nodeId`, scoped to the requester's account, through one consolidated `pendingAccountRequests` table (mirrors the existing `provision_target_request`/`ssh_discovery_request` pattern); a successful disconnect also forgets the account's synced metadata row (`ConnectedAccountStore.remove`, new on the store interface, in-memory and Postgres).

  `packages/node`: `NodeDaemon` now runs `GithubConnectService`/`JiraConnectService`/`AccountPinStore`/`account-pin.ts`'s resolvers against these messages — the device flow's user code streams back before the terminal result, a disconnect deletes the local keyring secret, and pin resolution surfaces `AccountPinRequiredError`/`AccountPinMalformedError`/`AccountHostMismatchError`/`AccountPinDanglingError`/`AmbiguousAccountError` as real, distinguishable response states.

  `apps/web`'s `RelayClient` gains a `connectedAccounts` reactive store (fed by the existing `connected_account_list` snapshot) plus `startGithubConnect`/`connectJiraAccount`/`disconnectAccount`/`getAccountPins`/`setAccountPin`/`unsetAccountPin`/`resolveAccountPin`/`refreshConnectedAccounts` — the write-path client API #230's UI is built against.

  **Scope note**: this change ships the wire protocol, relay routing, node handlers, and client API only. The Svelte UI itself (a Settings "Accounts" section, the device-flow/API-token connect forms, the per-project pin picker, and the disconnect confirmation) is tracked separately — see issue #230's own thread for the remaining UI work.

- 99e3583: Native tracker: kanban/list UI with custom type support (SPEC §7.10)

  Adds the client surface for loombox's own local tracker (`packages/shared`'s `NativeTrackerStore`, #210): a full-width Tracker page reachable from the left sidebar once a session is selected, with a kanban board and a priority-sorted/assignee-filtered list view, both driven entirely by `@loombox/protocol`'s new role-driven helpers (`resolveRoleValue`/`groupByWorkflowStatus`/`sortByPriority`/`filterByAssignee`) so a built-in Task/Bug/Epic and a project-defined custom type render identically — nothing in this feature branches on a record's `primaryType`.

  `@loombox/protocol` gets `tracker-records.ts`: the wire schema (`TrackerRecordV1`/`TrackerTypeDefinitionV1`) plus four new encrypted, session-scoped wire messages — `tracker_snapshot_request`/`_response` (read) and `tracker_write_request`/`_response` (create/update/defineType) — mirroring `fs.ts`'s existing pattern exactly. `@loombox/node` wires these into `NodeDaemon` against the same `NativeTrackerStore` a future MCP host will bind an agent's `tracker_*` tools to, so a human edit and an agent write land in the same on-disk file. `@loombox/relay` routes both pairs to/from the owning node exactly like `fs_list_request`/`_response`.

  The UI ships: empty state with a "New record" CTA, a retryable `ErrorNotice` (matching the Files panel's #582 "didn't answer in time" wording) for both a wire error and a client-owned bounded-wait timeout, and a loading state that always terminates. The kanban board answers issue #212's mobile requirement directly: at <=767px it renders one column at a time with Prev/Next controls instead of a horizontal scroll of narrow columns. Moving a card between columns has two paths — native HTML5 drag-and-drop for a desktop mouse, and a fully keyboard/touch-operable "Move to" `Select` on every card — both calling the same `RelayClient.updateTrackerRecord`, never local component state. A "New type" dialog lets a project define a custom type's `roles` mapping (which `fields` key holds title/status/priority/assignee), after which every generic surface renders it correctly with no code change.

- e05423a: Add per-project test/lint/build command configuration and auto-detection (SPEC §7.15, issue #245)

  A project's test/lint/build commands can now be read, saved, and auto-detected through the owning node: `TestRunnerConfigStore` (`@loombox/node`) persists them per project (mirrors `PermissionPolicyStore`'s JSON-file shape), and `detectTestRunnerCommands` proposes commands from `package.json`'s `scripts` block via whichever `ExecutionTarget` the project's session runs on (`local` or `ssh:`), picking `pnpm`/`yarn`/`npm` syntax off the project's lockfile. Detection only ever proposes a command for a script that genuinely exists — never a guessed default for a project with nothing detectable.

  Five new v1 wire messages (`test_runner_config_get`/`_set`/`_detect` client-to-node, `test_runner_config_result`/`_detected` node-to-client), routed/fanned out by the relay exactly like `fs_list_request`/`fs_list_response`, sealed under the session key so no command string ever reaches the relay in the clear. `RelayClient` gains `getTestRunnerConfig`/`setTestRunnerConfig`/`detectTestRunnerConfig`; `ProjectConfigPanel` gains a new "Test, lint & build" section (`TestRunnerConfigPanel`) with per-command explicit save and an "Auto-detect" action whose suggestions are shown for confirmation and never applied without an explicit Accept click.

  This ships the configuration half of SPEC §7.15's test runner (issue #245); the streaming execution half (issue #244, running the configured commands with live output and cancellation) is tracked separately.

- 635e20d: Add the streaming test/lint/build runner surface (SPEC §7.15, issue #244)

  Running a project's configured test/lint/build command (issue #245's config half) now streams live results from the cockpit instead of requiring a raw terminal. `packages/node/src/test-runner-process.ts` runs the command via `sh -c` on either target: locally with `child_process.spawn({ detached: true })`, so a cancel kills the whole process group (`process.kill(-pid, 'SIGKILL')`), not just the launcher; over `ssh:` it reuses the existing `RemoteProcessRunner` (setsid+fifo+log-tail) rather than opening a second channel, adding its own exit-code side-channel on top since that runner never captured one for a background job, and its cancel goes through `RemoteProcessRunner.stop()`, whose `setsid` branch now kills the whole remote process group (issue #642/#645). Both targets classify "command not found" as a uniform POSIX 127 instead of branching on ENOENT vs. remote shell text. `NodeDaemon` evaluates the project's permission policy (`evaluateCommandLine`, the same entry point `PolicyEnforcedPty`/`PolicyEnforcedExecutionTarget` use) before ever spawning, so a denied command surfaces as `could_not_start` with a policy reason and never runs.

  Five new v1 wire messages (`run_start`/`run_cancel` client-to-node, `run_started`/`run_output`/`run_exit` node-to-client), modeled on `terminal.ts`, routed/fanned out by the relay exactly like `terminal_open`/`terminal_output`, sealed under the session key so no command, output, or outcome ever reaches the relay in the clear. `RelayClient` gains `startRun`/`cancelRun`/`onRunOutput`/`runsFor`. The right sidebar's Files/Config sub-tabs gain a third "Runner" tab (`RunnerPanel.svelte`): one Run/Cancel action per configured command, its combined output streaming live (reusing the display-only `TerminalOutput` component), settling to a pass/fail/could-not-start state with the real exit code.

  Cancelling reaps the whole process tree on both targets, including forked grandchildren — verified with a `sleep 30 &`-forking fixture at the process, `NodeDaemon`, and (ssh) `RemoteProcessRunner` layers. Closing a node now also cancels every still-running local/ssh run instead of leaking it, the same way it already does for open terminals.

## 0.2.0

### Minor Changes

- 5118b26: Add the `ConnectedAccount` data model and its relay metadata sync (SPEC §7.26)

  `@loombox/protocol` gets `v1/connected-accounts.ts`: the provider-agnostic `ConnectedAccount` type, Zod-validated and registered in `schemasV1` field-for-field per spec (`id`, `provider`, `host`, `providerAccountId`, `label`, `avatarUrl`, `credentialSource`, `scopes`, `capabilities`, `connectedAt`, `updatedAt`, `secretRef`). `id` is derived, never free-form: `composeConnectedAccountId`/`parseConnectedAccountId` round-trip `provider:host:providerAccountId`, tolerant of a colon-bearing `host` (a GitHub Enterprise Server or Jira Data Center instance on a non-default port). `providerAccountId` rejects anything shaped like an email address for every provider, and additionally requires a numeric value for `github` (GitHub's own `GET /user` id). There is deliberately no `nodePresence` field: which node holds a given account's secret locally is computed lazily at the point of use (issue #228), never synced.

  `@loombox/relay` wires the metadata row through its existing account-scoped sync path: a `ConnectedAccountStore` (in-memory and Postgres, new `connected_accounts` table), a node-only `connected_account_announce` message, and a client-only `connected_account_list_request`/`connected_account_list` pair, mirroring `target_announce`/`target_list_request` exactly. The synced row never carries a secret: `secretRef` only names a node-local OS-keyring entry (the same class of secret as SSH keys and MCP secrets), and the row is relay-readable plaintext by design, the same "account-scoped metadata" exception SPEC §8 already grants session existence and the device registry.

  No connect flow ships here (GitHub device grant, `gh` CLI import, PAT paste, Jira token, Jira 3LO are issues #222-#226), no management UI (#230), no per-project pinning (#227), no node-presence computation (#228, referenced above).

- a449b22: Add per-target concurrency caps with a FIFO overflow queue (SPEC §7.16)

  `@loombox/node` gets a `SessionConcurrencyGate` (`session-concurrency-gate.ts`), the one chokepoint every session's launch — `local` and `ssh:` alike — passes through in `NodeDaemon.createSessionInternal`/`scheduleSshSession`. Starting a session beyond its target's configured cap queues it (wire status `'queued'`, distinct from the existing `'starting'`) instead of launching it; a session that finishes, crashes, is killed, or is stopped (`session_archive_request`) releases its slot and hands it to the oldest still-queued session on that target, FIFO. A queued session can be cancelled (also via `session_archive_request`) and never launches. Lowering a target's cap never kills sessions already running past the new limit, it only gates future starts.

  The default cap differs by target kind, since their known resources differ: `local` defaults to this host's own CPU core count (`os.cpus().length`, the same source `resource-sampler.ts` already reads), while an `ssh:` target defaults to a conservative `2` (its real capacity is unknown until an operator sets `SshTargetConfig.maxConcurrentSessions` or turns on resource sampling). `local`'s own cap is configurable via `NodeDaemonOptions.localMaxConcurrentSessions` / `LOOMBOX_LOCAL_MAX_CONCURRENT_SESSIONS` / the config file's `localMaxConcurrentSessions`.

  `@loombox/protocol` widens `sessionStatusV1` with `'queued'`, alongside the existing `'starting'` — both synthesized by the node rather than passed through from the agent process. This is an additive enum change: an older peer simply drops a `session_status` envelope carrying a value it doesn't recognize.

  Also fixes a real bug found while building this: `NodeDaemon.close()`/the new per-session stop path called `AgentSupervisor.stop()` with the loombox-level session id, but the supervisor keys its sessions by the ACP-level id the agent's own `session/new` response assigns — the wrong key meant `.stop()` never actually found the session, so the child agent process was never killed, only reaped incidentally when the whole node process exited.

- c97a2cf: Add the `TrackerMode` config and the pluggable `TrackerBackend` extension point (SPEC §7.10)

  `@loombox/protocol` gets `v1/tracker.ts`: Zod-validated `githubTarget`/`jiraTarget` and the `trackerMode` discriminated union (`{kind:'native'}` or `{kind:'live', provider, connectionId, target}`), exported and registered in `schemasV1` alongside every other v1 schema. The exported `TrackerMode` type keeps SPEC's literal `target: GitHubTarget | JiraTarget` shape (not correlated to `provider` at the type level, exactly as specced), but the schema adds a `superRefine` cross-check so a GitHub-shaped target submitted under `provider: 'jira'` (or the reverse) is rejected at parse time, since that correlation is clearly the spec's intent even though its type block does not encode it.

  `@loombox/shared` gets its first real export: `TrackerBackend` and `TrackerBackendCapabilities`, plus the `TrackerBinding`/`TrackerListFilter`/`TrackerListPage`/`TrackerItemLive`/`TrackerTransition`/`TrackerBoard`/`TrackerSprint` shapes those methods reference. `list`/`get`/`create`/`update`/`listBindings` are required; `addComment`/`listTransitions`/`transition`/`listBoards`/`listSprints`/`moveToSprint` are optional, matching SPEC §7.10's phased delivery (issues/comments first, transitions next, boards/sprints last). A type-level `satisfies TrackerBackend` check in `tracker-backend.test.ts` proves a stub implementing only the required methods still satisfies the interface with every optional method absent, and fails to compile if that ever stops being true.

  `apps/web` gets `$lib/tracker-mode-store.ts`, a per-project persisted `TrackerMode` (localStorage today, same injectable-storage pattern as `mcp-server-store.ts`/`plugin-store.ts`). `get()` returns `TrackerMode | undefined`: an unset project, or one whose stored value no longer validates, both read as `undefined`, never silently coerced to `{kind:'native'}`. No consumer wires this store into the UI yet; that is issue #212's job.

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
