# @loombox/node

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
