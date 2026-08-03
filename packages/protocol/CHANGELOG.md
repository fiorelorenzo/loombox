# @loombox/protocol

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
