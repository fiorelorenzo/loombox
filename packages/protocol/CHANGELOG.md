# @loombox/protocol

## 0.7.0

### Minor Changes

- 97598db: Custom ACP agents defined per project, gated by a node-side allowlist (D1-3, issue #748)

  `@loombox/protocol`: `customAgentRecordV1` (name/command/args/env/defaultMode/defaultConfigOptions) rides `sessionPrivateMetaV1.customAgent`, encrypted exactly like `title`/`projectPath`. A new `custom_agent_probe_request`/`custom_agent_probe_response` pair (mirrors `target-fs.ts`) lets a client check installed-vs-allowed on a target before ever creating a session. `sessionStatusEventV1` grew an optional `reason` so an `'error'` status can carry a verbatim message.

  `@loombox/node`: `custom-agent.ts` — `assertCustomAgentAllowed`/`isCustomAgentCommandAllowed` (the actual security boundary), `CustomAgentNotAllowedError`, `createCustomAgentProvider`. The allowlist itself (`NodeCliConfig.customAgentAllowlist`) is file/env-only (`LOOMBOX_CUSTOM_AGENT_ALLOWLIST` or the config file's `customAgentAllowlist`), defaults to `[]` on a fresh node, and has no wire message that reads or writes it — never reachable from a client. `NodeDaemon` gates every custom-agent launch (`local` and `ssh:`) through it before ever registering a spawn recipe; a refusal reports `session_status: 'error'` with `reason` naming the allowlist. `applyCustomAgentDefaults` best-effort-applies a custom agent's `defaultMode`/`defaultConfigOptions` via the existing `session/set_config_option` mechanism.

  `@loombox/relay`: routes `custom_agent_probe_request`/`response` by `nodeId`, same pending-request-table pattern as `target_fs_list_request`.

  `@loombox/web`: `RelayClient.createSession` now takes an optional `customAgent`, sealed into the same private envelope as `title`/`projectPath`; `RelayClient.probeCustomAgent` is the client half of the probe pair. A new per-project `custom-agent-store.ts` (`localStorage`-keyed, mirrors `mcp-server-store.ts`'s CRUD pattern) backs `NewSessionDialog`'s "+ Define a custom agent" form, which folds a project's custom agents into the same Agent picker as its registered providers (`custom-agent:<name>` ids, never colliding with a real provider id) and sends `provider: 'custom'` alongside the record on submit.

  **The allowlist's edit path**, in full: an operator sets `LOOMBOX_CUSTOM_AGENT_ALLOWLIST` (comma-separated) or the node config file's `customAgentAllowlist` (JSON array) and restarts the node (`packages/node/src/config.ts`'s `NodeCliConfig.customAgentAllowlist` doc comment, threaded through by `main.ts`'s `start()`). No wire message reads or writes it, so it is architecturally unreachable from any client, no matter which device or account.

- ff1fb1e: Fork a session from any turn into a new one (issue #746, Zed-parity decision C6-2). The transcript up to that turn is copied into a brand-new session with its own worktree, seeded from the source's branch tip plus an overlay of the source's uncommitted and untracked files, so the fork's files match the transcript it starts from. The original session and its worktree are untouched: nothing here reverts anything, which stays C6-3's job and depends on #603.
- 7ad7274: Wire `@loombox/supervisor`'s `GitCheckpointStore` (issue #266) into a running session and the wire protocol (issue #603). `NodeDaemon` now takes an automatic checkpoint right before every turn's prompt reaches the agent — before the whole turn, not just its first tool call, since ACP `session/update` notifications are fire-and-forget and there is no request/response boundary this node could synchronously interpose on between "the agent decided to write" and "the write already happened"; before the turn is the earliest point this node can actually guarantee, and it strictly subsumes "before the first write". Best-effort: a checkpoint failure is logged and never blocks the turn itself.

  Four new v1 wire messages (`checkpoint_create`/`_list`/`_restore_preview`/`_restore`, each with its own reply carrying an `outcome: 'ok' | 'error'` — `_restore` also `'confirmation_required'`), routed/fanned out by the relay exactly like `test_runner_config_get`/`_set`/`_detect`, sealed under the session key so a checkpoint's label, commit graph, and restore outcome never reach the relay in the clear. `checkpoint_restore` requires an explicit `confirm: boolean`: an unconfirmed restore that would discard anything uncommitted answers `confirmation_required` with the same `RestorePreview` `checkpoint_restore_preview` surfaces, and never touches the worktree — the structural half of "a rollback that would discard uncommitted human edits must say so before it runs". It also refuses while the session's own agent is actively mid-turn, so a restore can never race a live write.

  Every checkpoint/preview carries `isWorkInPlace` (`Session.branch === ''`): the engine treats an isolated worktree and an in-place session identically, but only an in-place session's worktree is the user's actual project folder, so this is the signal a client needs to warn accordingly rather than guessing. An `ssh:`-target session gets a clear `errorType: 'unsupported_target'` instead of a confusing failure: the engine spawns `git` as a local child process, so a remote session's `worktreePath` is not reachable from this node at all. A session's checkpoint refs are deleted (`GitCheckpointStore.deleteAllCheckpoints()`) whenever `SessionManager.removeSession` forgets it, so hidden refs never accumulate in the user's repo.

  This is the blocker both #268 (the rollback confirmation UI) and #747 (rewind) were waiting on. Neither is built yet: #268 still needs the client list/create/confirm UI over this wire surface, and #747 still needs to map a turn to the checkpoint taken before it (this wiring already takes one checkpoint per turn boundary, labeled `auto: before turn <n>`, for exactly that) and its own transcript-truncation half.

  `GitCheckpointStore.checkpoint()` itself now issues its independent `git` reads in parallel and one call fewer, plus a single retry on a transient subprocess-spawn failure: measured at 45-90ms serial per checkpoint against a real repo with zero contention. The automatic per-turn checkpoint stays serial — `await`ed before `agentSession.prompt()`, and in `deliverPrompt` ahead of attachment resolution too — after running it concurrently via `Promise.all` was found to let a caller (a test's teardown, in practice) delete a session's worktree while `checkpoint()` was still writing into it, surfacing as `ENOTEMPTY` on otherwise-unrelated tests on a clean CI runner; a per-bridge queue still orders two turns' checkpoint attempts against each other so they never race the same worktree either way.

- 79f55e0: Wires the browser's own MCP config/status surface into the one resolution path #750 (D2-2) built on the node (issue #794).

  - `apps/web`'s Config panel (`McpServerConfigPanel.svelte`) now forwards its per-project `mcp-server-store.ts` list — only the currently-enabled records — into `RelayClient.createSession`'s new `mcpServerConfigs` option, which seals it into `session_create`'s private envelope exactly like `title`/`projectPath`. A server added there is launched for the very next session on that project.
  - The node's `mcp_server_status` event gains a `disabled` flag (`@loombox/protocol`'s `mcpServerStatusEntryV1`, mirrored in `@loombox/providers-core`'s `AcpMcpServerStatusEntry`): `true` only on the exact failure that just auto-disabled the node's own `McpConfigStore` record after three consecutive failures (`NodeDaemon.recordMcpServerOutcome`/`autoDisableMcpServer`, now reporting instead of only logging).
  - The Config panel renders a new "Server status" section off `RelayClient.mcpServerStatusesFor(sessionId)` (threaded through `ProjectConfigPanel`): every failed server by name and reason, with an auto-disabled one visibly distinct from one that will simply be retried next session — including a server only the node itself is configured with, not just this device's own list.
  - New copy on the "Configured servers" section makes the two-store merge legible: this device's own declarations are one input the owning node merges with its own store, not the whole truth.
  - No secret value crosses either surface: `mcp-server-store.ts` never held one, and `mcp_server_status.reason` is always the human-readable failure detail, never a secret (`mcp-secret-grants.ts`'s node-local boundary unweakened).

- 6d3ad95: Consume MCP prompts and surface them as slash commands (Zed-parity D5-2, issue #754). The node now speaks MCP directly (`@loombox/providers-core`'s new `mcp-prompt-client.ts`, hand-rolled JSON-RPC over stdio/HTTP, mirroring `AcpClient`'s own conventions) — a second, independent connection per launched server, separate from whatever the ACP agent itself does with `mcpServers` at `session/new`, since a real `omp acp` binary never forwards an MCP server's prompt catalogue onto its own `available_commands_update`.

  Right alongside `mcp_server_status`, a new `mcp_server_prompts` session-lifecycle event (`@loombox/protocol`'s `session-events.ts`, same "ride the existing `session_update` envelope, no-op on an empty list" shape) carries every launched server's own `prompts/list` catalogue, attributed by server name. A server with no prompts contributes nothing; an unreachable server is silently excluded rather than breaking the push for the others.

  Selecting one in the composer's `/` picker (merged with the agent's own `commandsFor` catalogue, each MCP-sourced row tagged `mcpServer`/`mcpArguments`) sends the server's own rendered definition, not the raw typed text: a new `mcp_prompt_get_request`/`mcp_prompt_get_response` wire pair (`@loombox/relay` routes/fans it out exactly like `fs_list_request`/`fs_list_response`) asks the node to call that prompt's real `prompts/get`, with the user's typed argument text folded in. A failed render falls back to sending the user's raw typed text rather than blocking the send.

  Resources (D5-3) stay out of scope.

- 6325366: Launch a session's MCP servers on its execution target, local or `ssh:` (Zed-parity D2-2, issue #750). `NodeDaemon.resolveMcpServers` is now the one resolution path: this node's own `McpConfigStore` (global + project) merged with a client's per-project `mcpServerConfigs` declarations, forwarded inside `session_create`'s encrypted `SessionPrivateMetaV1` (`@loombox/protocol`'s new `mcp-servers.ts` schema, mirrored client-side, never a secret value). Secrets keep resolving node-side and are injected at launch, never sent to the relay.

  A server that fails to start — a missing binary or a failed MCP handshake — is excluded from that one attempt and retried without it (`startAgentWithMcpFallback`), so the session still opens with its remaining servers instead of quietly losing tools; the exclusion, its category (`missing_binary` | `handshake_failed` | `secret_missing`), and the underlying reason are pushed as a new `mcp_server_status` session-lifecycle event (`@loombox/protocol`'s `session-events.ts`, mirrored in `@loombox/providers-core`'s `AcpSessionWireEvent`/`TranscriptState.mcpServerStatuses`). A revoked/ungranted secret grant fails before any worktree/lease/agent is touched, and is now visible on the wire too (a minimal `session_announce` plus `session_status: 'error'` and `mcp_server_status`, both naming the server), not just a `console.warn`. Three consecutive failures for the same node-store-owned server auto-disable it (`McpConfigStore.setProjectEnabled`/`setGlobalEnabled`); a client-declared server has nothing here to disable, so it keeps being reported until the client acts. A server that already started is unaffected by a sibling's failure.

- d03fc5d: Open a pull request from a session's own branch (SPEC §7.14, issue #238). `@loombox/protocol` gains `pr.ts`'s `pr_open_preview_request`/`_result` and `pr_open_request`/`_result` wire pair, routed session-scoped through the relay exactly like `permission_policy_get`/`_set` (the relay only ever forwards `sessionId`/`requestId` plus opaque `EncryptedEnvelope`s — never a branch name, commit count, PR title/body, or the created PR's URL).

  `@loombox/node`'s new `pr-open.ts` runs `git`/`gh` on the session's own `ExecutionTarget` (`local` or `ssh:`), authenticated by that target's own already-signed-in `gh` CLI — deliberately not SPEC §7.26's connected-account registry (`GithubConnectService`), whose token lives in one node's OS keyring and cannot reach an `ssh:` target's `gh` invocation at all (`ExecOptions.env` is local-only) or add anything a target's own git-push credentials don't already provide for a `local` one. `previewPrOpen` is read-only (resolves the session's branch via `resolveSessionBranch`, issue #738; the repo's default branch via `gh repo view`; and the commit count ahead of it) and reports one of seven named failure categories (`no_branch` | `no_commits` | `gh_missing` | `gh_unauthenticated` | `repo_lookup_failed` | `push_failed` | `create_failed`) rather than one generic error, mirroring issue #750's `AcpMcpServerFailureCategory` precedent. `openPr` re-verifies that same preview immediately before it pushes the branch and runs `gh pr create` — the one point in the whole feature with a real side effect on the operator's own repository.

  `apps/web`'s `RelayClient` gains `previewPrOpen`/`openPr`, and a new `PrOpenDialog.svelte` — reached from any session row's "⋯" menu ("Open pull request…"), alongside "Archive session…"/"Export transcript": an occasional, per-session action, not a permanent workbench sub-tab beside Files/Config/Runner (those stay relevant for a session's whole lifetime; opening a PR happens once, near the end). The dialog shows the preview (branch, base, commit count) the moment it opens, then only pushes and opens the PR once the operator has typed a title and clicked "Push & open pull request", surfacing the resulting URL or a distinct failure reason inline. No AI-drafted PR body here (issue #233's scope, not this one's).

- 757fa0e: Per-project scoped secret/env injection for agent execution (issue #258): a project can declare env vars its spawned agent process gets at start, each either a literal value or a reference to a node-local secret by name — resolved and injected only on the executing node, never sent to the relay or a client.

  - `@loombox/providers-core`'s `project-env.ts` mirrors `mcp-secret-grants.ts` (issue #189): `ProjectEnvVarDecl`, a per-secret `ProjectEnvGrantStore` (deliberately separate from `McpSecretGrantStore` — direct agent-env injection is a distinct trust boundary from an MCP server grant), and `resolveProjectEnv`, which fails fast on an ungranted/missing secret before returning anything.
  - `@loombox/protocol`'s `sessionPrivateMetaV1.projectEnvDecls` carries a client's declared list inside the same encrypted envelope as `title`/`projectPath`/`mcpServerConfigs`.
  - `@loombox/node`'s `NodeProjectEnvManager` persists only the grant ACL and reuses `NodeMcpSecretManager`'s existing keyring-backed secret-value storage rather than a second store, so a secret set once is usable by both an MCP server grant and direct env injection. `NodeDaemon` resolves it alongside `mcpServers` at session start, in the same before-any-worktree preflight path that already fails clearly on a bad MCP grant — a missing/ungranted secret now gets the identical treatment (a minimal `session_announce` plus `session_status: 'error'` naming the env var and secret). `ssh:` targets refuse a declared env var outright for now (the sandboxing dependency, issue #257, is still open) rather than silently starting an agent missing it.
  - `@loombox/supervisor`'s `AgentSupervisor.start()` gains an `env` option, merged into the provider's own `spawnConfig.env` before spawning — never sent anywhere but the local `child_process.spawn()` call.
  - `@loombox/web` gets `project-env-store.ts` (client-side declaration CRUD, mirrors `mcp-server-store.ts`) and `ProjectSecretsPanel.svelte`, mounted in the Config panel next to MCP servers; `RelayClient.createSession()` and `NewSessionDialog` forward the declared list on every session creation, the same way `mcpServerConfigs` does.

- dace883: Turn-indexed session rewind (design spec `2026-08-05-zed-parity-decisions.md`'s C6-3; issue #747), built on top of #603/#805's `GitCheckpointStore` wiring: the same session, its transcript and its worktree, roll back together — destructive, and confirmed before it runs.

  Two new v1 wire messages, `session_rewind_preview`/`session_rewind`, distinct from `checkpoint_*`: `turn` is a plain, node-resolved integer (the same counter #805 already stamps into its `auto: before turn <n>` checkpoint labels), not the ACP-level `turnId` string. `@loombox/node`'s `session-rewind.ts` builds the turn→checkpoint index #805 deliberately left unbuilt, by reading that label back — no separate persisted structure to keep in sync, since the checkpoints' own hidden refs already are the persistence. Rewinding to `turn: N` restores the checkpoint taken before turn `N + 1` (keeping turn `N`'s own effects, discarding everything after) and truncates the session's transcript to match, in the same operation, so the thread and the worktree can never disagree.

  `session_rewind`'s confirmation gate reuses #805's own `confirmation_required` mechanism rather than inventing a second one — every valid rewind target discards at least one turn, so an unconfirmed rewind always answers `confirmation_required` with a preview naming exactly what's at risk: `filesAtRisk` (new `@loombox/supervisor` method `GitCheckpointStore.filesAffectedByRestore()`, a file-level diff between the worktree's current state and the target checkpoint) and `turnsAtRisk`. `isWorkInPlace` (#805's own flag) is carried through unchanged, so a client can render the sharper warning an in-place session's uncommitted state deserves. An `ssh:` session gets `errorType: 'unsupported_target'`, same as `checkpoint_*`; a session with no live agent (disconnected since a node restart) gets a new `errorType: 'no_live_agent'`, since truncating a transcript needs the live `AgentSession` object holding it — reviving one on demand is issue #706's own scope, not this one.

  `@loombox/supervisor`'s `TranscriptStore` gains `truncateTranscriptUpdates()` (the one place its append-only log design is deliberately broken, since rewind is the one operation that needs it to shrink) and `AgentSession` gains its own `truncateTranscriptUpdates()`, the mirror image of the fork-seeding `seedTranscriptUpdates()` already shipped for issue #746.

- 89355b1: Per-project and per-session spend caps with auto-pause (SPEC §7.16; issue #251)

  A session's cumulative cost (the same rollup §7.9's usage meter shows, subagent cost included) can now be capped, and crossing the cap auto-pauses the session rather than letting it run unbounded:

  - Two independent scopes: a project-wide cap (`@loombox/node`'s new `SpendCapStore`, one JSON file per node, mirroring `PermissionPolicyStore`'s shape) and a session-scoped cap (`SessionManager`'s new `Session.spendCapUsd` field, persisted through the existing `SessionStore`). The session's own cap wins when both are set — `NodeDaemon.effectiveSpendCapUsd` is the one place that resolution happens.
  - `NodeDaemon` accumulates each session's cumulative cost from every `usage_update.costUsd` it forwards (a running max, mirroring `@loombox/providers-core`'s `reduceUsage`) and never treats "this agent has never reported a cost" as `$0` real spend — a cap simply cannot fire until a real cost figure exists, no matter how low it's set.
  - Crossing the cap pauses the session (`SessionManager.pauseSession` — the agent process is untouched, exactly per its own "independent of the supervisor's own process-level concerns" design) and pushes a new `'paused'` `session_status` (protocol enum widening, same category as `'queued'`/`'starting'`/`'disconnected'`) carrying a `reason` in the same field issue #730 added for a spawn failure.
  - A cap crossed mid-turn (the agent still `'working'`/`'permission_required'`) is deliberately let finish rather than interrupted — there is no ACP-level turn-interrupt wire message yet (`RelayClient.interruptTurn`'s own doc comment says so directly), and the issue's own acceptance line rules out "silently killed." The pause lands the instant the turn actually settles; the UI never claims `'paused'` early.
  - Resuming is always a deliberate client act, never automatic: `session_spend_cap_resume` (explicit "continue anyway," envelope-less like `run_cancel`) or a `spend_cap_set` that raises the effective cap back above current spend (auto-resumes as a side effect of that one act). Either path advances a watermark so the same cap doesn't immediately re-fire for spend that never actually changed — it re-arms only once NEW spend grows past it.
  - New wire messages: `spend_cap_get`/`spend_cap_set`/`spend_cap_result` (mirrors `permission_policy_get`/`_set`/`_result`'s shape exactly) and `session_spend_cap_resume`, routed by the relay to the owning node without ever seeing a project's or session's actual dollar figure.
  - `apps/web`'s `session-status.ts` (the one place a session status becomes words, read by both the status bar and every session row) now renders `'paused'` distinctly — its own tone plus the always-populated `reason`, so a cap pause never reads like a generic failure or another kind of pause.

  Not in this change (left for a follow-up issue, since the enforcement mechanism above is complete and independently testable over the wire): a settings panel to set caps from the UI, a "Resume" button, and cross-project attention-inbox/push-notification wiring for a paused session. The protocol/node layer is the full, real implementation; the client surface today is read-only (a paused session's status and reason are visible everywhere `SessionStatusV1` already renders) plus the wire API (`spend_cap_get`/`_set`, `session_spend_cap_resume`) any future panel calls directly.

  Verified: `pnpm --filter @loombox/protocol exec vitest run` (594 tests), `pnpm --filter @loombox/node exec vitest run src/node-daemon-spend-cap.test.ts src/spend-cap-store.test.ts src/session-manager.test.ts` (76 tests), `pnpm --filter @loombox/relay exec vitest run src/relay.test.ts` (121 tests), `pnpm --filter @loombox/web exec vitest run src/lib/components/StatusBar.test.ts src/routes/page.test.ts` (109 tests), `pnpm -r typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

- 109184d: Topbar shows `project / branch`, and the session's target chip moves down into the status bar's left zone (Zed-parity decision B3-3, issue #738).

  - `@loombox/protocol`: `SessionPrivateMetaV1` gains an optional, node-computed `branch` field. A client never sends it — only `@loombox/node`'s own `announce()` sets it.
  - `@loombox/node`: a new `resolveSessionBranch` helper resolves the branch a session's own state should report. A worktree-isolated session already knows its own `loombox/session-<id>` branch, no git call needed; an in-place session gets a fresh `git branch --show-current` probe against its project folder on every `announce()` (session creation, a fork, and every reconnect's re-announce) — a detached `HEAD` resolves to `detached@<short-sha>` rather than a blank value, and a plain, non-git folder (SPEC §6) resolves `undefined`, not an error.
  - `@loombox/web`: the topbar's `.topbar-breadcrumb` now reads `project / branch` instead of `project · target`, omitting the branch segment entirely when the node has nothing to report. `StatusBar`'s left zone gains a `selectedSessionTargetLabel` segment (`status-bar-session-target`) carrying the target the old breadcrumb used to show — the target still appears exactly once in the window, just one level down.
  - `@loombox/web`: below `--bp-tablet` (390px phones, same convention `.topbar-breadcrumb`'s own narrow media query already uses), the new `status-bar-session-target` segment drops out of `StatusBar` entirely — it is the least useful LEFT-zone segment at that width, and dropping it is what keeps the bar inside the composer strip's own phone-width budget (`composer-strip.spec.ts`'s "fits one row on a phone"). Still discoverable there: the sessions sheet's own row for the open session already carries the identical label (`session-activity`, reachable from the bottom tab bar).

  This does not live-update an in-place session's branch the instant it changes on disk while the connection stays open — that would need either polling every open session's git directory or a filesystem watcher, neither of which this codebase uses elsewhere, and a person switching branches under a running session is a rare, deliberate action they already know about. It does refresh at every `announce()` (so a reconnect always shows the true current branch) and on a full reload.

- 4cc52b4: A full user keymap, remappable and synced per account (Zed-parity F3-3, issue #760, building on the action registry #758 and default binding set #759).

  Every registered action is remappable from Settings → Keyboard. Storage: a new account-scoped `keymaps` table on the relay (`keymap_get_request`/`keymap_set_request`/`keymap_result`), sealed under `@loombox/crypto`'s new `deriveKeymapKey` (`['keymap', accountId]`, no session or project involved at all — a keymap edit works with zero nodes online). Fetched proactively on every fresh connection, so a remap survives a new device sign-in from first paint; saved live to `RelayClient.keymap`, which `action-registry.ts`'s `effectiveShortcut`/`matchShortcut` now accept as an `overrides` param, so a remap takes effect without a reload everywhere the registry is read — the palette, the keyboard dispatcher, and `CanvasZeroState`.

  The two questions the decision required answering, not glossing over:

  1. **The phone.** The Keyboard settings section never renders on a narrow viewport (`SettingsPage.svelte`, gated on `viewport.ts`'s `isNarrowViewport`) — recording a chord has nothing to attach to with no physical keyboard to press. The resolved bindings still apply globally regardless of viewport (harmless with no keyboard, useful with a paired one).
  2. **Per-device availability.** The keymap stays a single per-account record with no per-device field. `$lib/keymap.ts`'s `isChordUnavailableHere` computes a runtime "unavailable here" state instead, generalizing issue #759's own browser-reserved-chord rule (`Mod+N`, `Mod+Alt+Right`/`Left`) to any user-remapped chord that lands on one of those reservations — a binding reserved on this device still saves and still works on another.

  An invalid or conflicting candidate (unknown action id, malformed chord, two actions sharing a chord) is rejected client-side by `$lib/keymap.ts`'s `validateKeymapCandidate`, naming the offending entry, before it is ever sent — the previously saved keymap is never touched. Two tabs on the same account: last full write wins at the relay, and every other open connection on that account is pushed the winning state live (not just the requester), so a losing tab corrects itself instead of drifting stale.

- 4291dc3: Add the working-tree diff viewer (SPEC §7.4, issue #206): a session's actual uncommitted changes (staged + unstaged + untracked, compared against `HEAD`), opened as a real tab in the canvas tab strip (issue #737) rather than a dialog.

  - `@loombox/protocol`: new `git_diff_request`/`git_diff_response` wire pair (`packages/protocol/src/v1/git-diff.ts`) — shaped like `fs_read_request`/`fs_read_response` (issue #737), no envelope on the request (asking carries no content, mirroring `checkpoint_list`).
  - `@loombox/node`: `packages/node/src/git-diff.ts`'s `computeWorktreeDiff` runs real `git status`/`git show` through `ExecutionTarget.exec` — the same `git -C <worktree> ...` shape issue #238's `pr-open.ts` already established, so this works against a `local` or an `ssh:` target identically. A binary/symlink change collapses to `DiffViewer`'s existing `oldText: null, newText: ''` structural-only shape; a deleted file gets `newText: ''`; a rename carries `previousPath`.
  - `@loombox/relay`: routes the new pair exactly like the `checkpoint_*`/`fs_read_*` families — always blind to the envelope's contents.
  - `@loombox/web`: `WorktreeDiffViewer.svelte` renders inline (reusing `DiffViewer.svelte` unchanged, per file) and split (reusing `$lib/diff.ts`'s `diffStats`/`computeLineDiff` via the new `pairDiffLinesForSplitView`, laid out in two columns) — no second diff algorithm anywhere. Split degrades to inline below the tablet breakpoint, where two columns have nowhere to go. Opens via a new "Working tree diff" button above the Files panel tree, as `$lib/tabs.svelte.ts`'s new `DiffCanvasTab` tab kind.

### Patch Changes

- 584520e: Named agent profiles that gate which tools a session may use at all (D3-4's "profiles" half, issue #752)

  Zed ships three built-in profiles (Write/Ask/Minimal), each a complete `Record<toolName, boolean>` over a closed tool catalog Zed itself defines. That shape does not fit here: the agent (Claude Code, Codex, a generic ACP binary, whatever MCP servers it connects to) owns its own tool list, not loombox — there is no upfront manifest of every tool an agent might call. A profile here is a **filter over whatever the connected agent actually declares**, not a definition of it.

  - `@loombox/node`: `agent-profile.ts` (new) defines `AgentProfile` — `deniedToolKinds` (ACP's own small, fixed 9-value `toolKind` taxonomy), `deniedToolNamePatterns` (anchored globs, reusing `permission-policy.ts`'s own dependency-free `*`/`?` language via the newly-exported `matchAnchoredGlob`, matched against a tool call's `title`), and `deniedMcpServers` (exact server names, omitted from `mcpServers` entirely before an agent ever spawns — the one place this feature can offer a real "the tool does not exist" guarantee). `evaluateAgentProfile` is the per-call enforcement chokepoint; `filterMcpServersForProfile` is the session-start one. An entry that never matches this agent's actual tools degrades quietly, never errors (issue #752's own acceptance line) — `agent-profile-store.ts` (new) persists the named catalog as one flat, account-scoped JSON file (this node serves exactly one account, so "per account" is "no scoping key at all", the same shape `McpConfigStore`'s own global list already uses).
  - `@loombox/supervisor`: `AgentSession` gains `evaluateToolProfile`, a resolver called fresh on every incoming `session/request_permission` — mirrors `PolicyEnforcedPty`'s `() => PermissionPolicy` resolver being re-read on every submitted line, so switching a session's profile mid-session applies starting with the very next tool call, never retroactively, never half-applied. A denial auto-resolves the request (replying to the agent's still-pending ACP call with a `reject_once` option when the agent offered one, else `cancelled`) before it ever becomes a human-visible `permission_required` — the request never reaches the FIFO queue at all. `AgentSupervisor.start`/`startWithChild` thread it through to `AgentSession.spawn()`.
  - `@loombox/protocol`: `agent-profile.ts` (new) — `agent_profile_list_get`/`_set`/`_result` (the named catalog, account-scoped, following `permission-policy.ts`'s own request/reply shape) and `agent_profile_session_get`/`_set`/`_result` (which profile is active for one session). `permission-policy.ts`'s `ToolRefusalReasonV1` grows the `kind: 'profile'` member #751 already reserved this seam for, and `permission_policy_violation`'s `surface` enum grows `'tool_call'` — reusing the exact same notification `@loombox/node`'s new `sendToolProfileRefusal` sends through, rather than a second, parallel attribution mechanism.
  - `@loombox/relay`: routes the four new client-to-node messages via `routeToOwningNode` and fans the two result types out via `fanOutDirect`, exactly like `permission_policy_get`/`_set`/`_result` — the relay never opens either envelope.
  - `@loombox/web`: `RelayClient` gains `listAgentProfiles`/`saveAgentProfiles`/`getSessionAgentProfile`/`setSessionAgentProfile`. `PermissionPolicyPanel`'s `ATTRIBUTION_LABEL` grows the `profile: 'Profile'` entry the file's own doc comment already anticipated (it was a compile error until this landed) and its `violationDetail` renders a profile refusal's own shape (which profile, matched by tool-kind or tool-name) alongside a policy refusal's — the same "Recent policy blocks" list now attributes both of D3-4's silent-refusal layers; the third (a request-time `allow_always`/`reject_always` answer) is already self-evident in the existing rendered `permission_response` UI and needed no new mechanism.

  Not in this change: a dedicated settings surface for creating/editing the profile catalog and picking a session's active profile from the UI (the wire protocol and `RelayClient` methods are complete and tested; only the panel itself is deferred — see issue #752's tracking comment for the exact resumption point). A session's active-profile choice is in-memory only on the node and does not survive a node restart (re-select it after reconnecting); the catalog itself is persisted and does survive one.

  Verified: `agent-profile.test.ts` (node, 15 tests) covers `evaluateAgentProfile`/`filterMcpServersForProfile` including every quiet-degrade case; `agent-profile-store.test.ts` (5 tests) covers persistence; `agent-profile.test.ts`/`permission-policy.test.ts` (protocol, 17+19 tests) cover the wire schemas including the widened union; `agent-session-profile.test.ts` (supervisor, 4 tests) drives a REAL `session/request_permission` round trip against `providers-core`'s own `permission-acp-agent.mjs` fixture, proving a denial never reaches the human queue and the agent really receives the reply, plus the mid-session-switch-applies-next-call guarantee; `node-daemon-agent-profile.test.ts` (node, 3 tests) drives the same fixture through a real relay + real encrypted session end to end, proving `session_create`'s `profileId` produces a `permission_policy_violation` naming the profile instead of a `permission_request`, that an unrestricted session is unaffected, and the `agent_profile_list_set`/`agent_profile_session_set` wire round trip. `PermissionPolicyPanel.test.ts` gained a test proving the profile badge renders and is distinguishable from the policy badge.

  ```
  pnpm lint && pnpm format:check && pnpm -r typecheck && pnpm test
  ```

  All green (full local gate run because this touches `packages/protocol`).

- a0fb0a6: A session whose agent never started, or failed to start, no longer renders as "Awaiting you" in the sidebar/inbox, and a spawn failure/timeout now reaches the client as a readable error instead of only a node-side `console.warn` (issue #730).

  - `@loombox/protocol`: `sessionStatusEventV1` gains an optional `reason`, set only alongside `'error'`.
  - `@loombox/providers-core`: `TranscriptState`/`AcpSessionStatusEvent` carry that `reason` through as `statusReason`; `reduceSessionEvent` threads it.
  - `@loombox/node`: `sendSessionStatus` takes an optional `reason`, passed through on every spawn failure (`launchLocalSession`'s catch). `ssh:` sessions (`launchReservedSshSession`) now report `'starting'`/`'error'` too — parity with `local`'s issue #516 handling, which they never had.
  - `@loombox/web`: `RelayClient.ensureSubscribed`'s first-ever subscribe for a session now retries `session_resume` until the relay's own `session_announce` acks it (new `sessionResumeRetryMs` option), then backfills anything already buffered with one `resync_request(sinceSeq: 0)` — closing the announce-vs-subscribe race a freshly created session lands in (`RelayClient.createSession`'s own doc comment named this issue's "remaining half"). New `RelayClient.statusReasonFor`. The composer, the sidebar/selvage rows, and the transcript pane now gate on every "no live agent" `SessionStatusV1` (`queued`/`starting`/`error`/`exited`/`disconnected`), not just `'disconnected'` (#702's prior scope), and show the reason where the node sent one.

  Does not fix #729 (the client still never resyncs on an ordinary reconnect for an already-open session) — this PR's resync is scoped to a session's first-ever subscribe, where duplication is provably impossible, not the general reconnect case.

- 0c46b48: Stop dropping `available_commands_update` on the floor, and carry the agent's declared `/`-command catalogue through to a client-side store (issue #741)

  `AcpClient.mapToTranscriptUpdate`'s switch had no case for `available_commands_update`, so it fell into `default: return undefined` — a real agent's declared command list (`omp acp`'s own doc comment already said prompting emits it) was silently dropped, exactly the gap `client.ts:409-461`'s own comment flagged. Both #743 (slash commands in the composer) and #754 (MCP prompts as slash commands) need this catalogue, so it is built once here as shared plumbing, with no UI.

  Follows the config-option catalogue's own shape end to end, the way the issue asked for, rather than inventing a second one:

  - `@loombox/providers-core`: a new `AvailableCommandsStore` (mirrors `ConfigOptionStore` — per-session, wholesale-replaced, `EventEmitter`-backed), fed by `AcpClient.availableCommands` off the real `available_commands_update` notification (`mapAvailableCommands`, same convention as `mapConfigOptions`). `TranscriptState.commands` carries it through `reduceSessionEvent` for the client-side reducer path.
  - `@loombox/protocol`: `acpAvailableCommandV1`/`availableCommandsUpdateEventV1`, a sixth `SessionLifecycleEventV1` member riding the existing `session_update` envelope (no new wire message type).
  - `@loombox/node`: `NodeDaemon.wireAgentSession` forwards `AgentSession.availableCommands`'s `'changed'` event as `available_commands_update`, same sealing/ordering/`sendQueue` as every other session-lifecycle event. `AgentSession` gained an `availableCommands` getter mirroring `configOptions`.
  - `@loombox/relay`: no change. `relay.ts` already forwards `session_update` opaquely without a per-kind switch, so this never needed a new case — checked directly against the drop-silently pattern issue #691 describes, since `available_commands_update` is not a new top-level `WireMessageV1` member.
  - `apps/web`: `RelayClient.commandsFor(sessionId)` reads `TranscriptState.commands`, the same "derived from the one reduced state" shape `configOptionsFor` already uses. No UI wiring — that is #743's job.

  An unrecognized/future field on a command (e.g. a future ACP `AvailableCommand` addition this client has never modeled) survives the whole round trip rather than being dropped: `acpAvailableCommandV1` is `.passthrough()`ed, not `.strict()`, and `mapAvailableCommands` spreads each wire entry through instead of reconstructing a picked-fields object — `AcpAvailableCommand` itself carries an index signature for exactly this, the same passthrough convention `AcpContentBlock` already uses for an unmodeled ACP content-block variant.

  Verified against the real `omp acp` binary (v17.2.9, reachable on this box): recorded a live `initialize` -> `session/new` -> `session/prompt` exchange to confirm `available_commands_update` only ever arrives as a notification during a turn, never seeded on `session/new` unlike config options (`test/fixtures/omp-acp-available-commands-update.json`), then drove the fixture end to end (`config-acp-agent.mjs`'s new `"trigger-commands"` prompt) through a real `AcpClient`, a real `NodeDaemon`/relay/`RelayClient` round trip, and the browser-side zod validation, each with a command carrying an unrecognized field to prove it survives every layer.

- 8a3fcda: A tab strip above the canvas for opened files and diffs, transcript pinned leftmost and non-closable (issue #737, settled pick B2-2)

  Today the canvas showed exactly one session and nothing else, and the file tree could only insert an `@`-mention — there was no way to actually see a file's content outside whatever diff card the agent's own edit produced. This ships a read-only file viewer plus the tab strip around it:

  - `@loombox/protocol`: a new `fs_read_request`/`fs_read_response` wire pair (`fs.ts`), mirroring the existing `fs_list_request`/`fs_list_response` pattern exactly — session-scoped, sealed under the session key, routed to the owning node by `sessionId` alone, fanned back out to every subscribed client. One-shot per open/retry, deliberately not a live subscription (C5-1: the Files panel — and, by the same reasoning, this viewer — stays a browsing tool, not a live view of the agent).
  - `@loombox/relay`: routes `fs_read_request` to the owning node and fans `fs_read_response` out to subscribers, grouped with the existing `fs_list_request`/`fs_list_response` cases.
  - `@loombox/node`: `NodeDaemon` answers `fs_read_request` via the session's existing `ExecutionTarget.readFile`, reusing `fs_list`'s own path-traversal guard. A 1MB cap truncates (reported via `truncated: true`, never silently); a `\u0000` byte anywhere in the decoded text is treated as binary and refused with a real error rather than forwarding garbled bytes.
  - `@loombox/web`:
    - `RelayClient.readFile(sessionId, path)`: a one-shot promise, same "resolves either way, rejects only when unusable" contract as `decommissionTarget`.
    - `$lib/tabs.svelte.ts`'s `CanvasTabsState`: the transcript tab is permanent, pinned first, and structurally never closable/reorderable. Opening the same path from any entry point (the Files panel tree, an `@`-mention pill, a diff card's own new "Open" affordance on `DiffViewer`) activates the same tab rather than duplicating it. The dirty indicator compares each tab's own transcript-position watermark against completed edit tool calls, not a wall clock, so "since you last looked" is exact.
    - `$lib/file-viewer.ts` + `FileViewer.svelte`: reuses `$lib/diff.ts`'s `languageForPath` and `$lib/markdown.ts`'s existing lazy-loaded `renderMarkdownToHtml`/`highlightMarkdownToHtml` pipeline (the file's content is wrapped in a fenced code block CommonMark can never parse as closing early) — no second syntax highlighter.
    - `CanvasTabStrip.svelte`: below `TABLET_VIEWPORT_BREAKPOINT_PX` (768px) the horizontal strip becomes a single active-tab-plus-picker (a `Dialog`-backed list of every open tab), the decisions doc's own named narrow-viewport option, covered by a spec at 390px.
    - Editing stays out of scope — #205 is that work.

- 166551b: Surface the node-side permission policy (command/network allow/deny globs) in the UI (D3-4's "rules" half, issue #751)

  `packages/node/src/permission-policy.ts` already enforced a per-project allow/deny glob policy, but nothing under `apps/web/src` referenced it — a user could neither see nor edit it, and it could only be hand-edited as JSON on the node.

  - `@loombox/protocol`: `permission-policy.ts` — `permission_policy_get`/`_set`/`_result` (session-routed, `_set`/`_result` sealed under `encryptedEnvelope`, following `test-runner-config.ts`'s shape) and `permission_policy_violation`, a node-to-client notification carrying `ToolRefusalReasonV1`, a discriminated union with one member today (`kind: 'permission_policy'`) — the seam D3-4's "the UI must say which of the three layers refused it" needs; the profiles half (#752) adds its own `kind: 'profile'` member alongside it rather than a second, parallel concept. Each glob rule is `.trim().min(1)`, so a blank rule is rejected at the schema boundary too.
  - `@loombox/node`: `NodeDaemon` gained `permission_policy_get`/`_set` handlers backed by the already-existing `PermissionPolicyStore`, plus `sendPermissionPolicyViolation`, wired into `PolicyEnforcedPty`'s `onViolation` hook and `executeRun`'s existing policy-denial path. **Fixes a real "no restart" bug found while writing this**: `PolicyEnforcedPty` used to snapshot the policy once at `terminal_open` time; since a terminal is long-lived, a rule added mid-session never took effect until that terminal was closed and reopened. `PolicyEnforcedPtyOptions.policy` is now a resolver (`() => PermissionPolicy`), read fresh on every submitted line, so a saved rule blocks the very next command with no node restart.
  - `@loombox/relay`: routes `permission_policy_get`/`_set` to the owning node and fans `permission_policy_result`/`permission_policy_violation` out to subscribed clients, exactly like `test_runner_config_get`/`_set`/`_result` and `terminal_output` — the relay never opens either envelope.
  - `@loombox/web`: `RelayClient` gains `getPermissionPolicy`/`setPermissionPolicy`/`onPermissionPolicyViolation`. `ProjectConfigPanel` (the right-workbench Config tab, per-project — not global Settings, since the policy is per project) gains a new `PermissionPolicyPanel` section: view/add/remove command and network allow/deny rules, a computed (never separately stored) "default: allow" / "default: only listed commands run" badge per dimension derived from whether that dimension's allow list is empty, and a live "Recent policy blocks" list fed by `permission_policy_violation`, each line naming the exact deny rule that fired. A blank pattern is rejected client-side at the Add button, with a message, before it ever reaches the wire.

  Verified: a new node-level test (`node-daemon-permission-policy.test.ts`) drives a real terminal + real bash + real relay end to end — sends `permission_policy_set` over the wire, then types a now-denied command into the SAME already-open terminal on the SAME running node, and confirms it's blocked with no restart; a companion `policy-enforced-pty.test.ts` test proves the same at the unit level. `node-daemon-test-runner.test.ts` confirms the same violation notification fires from the `run_start` policy-denial path. `PermissionPolicyPanel.test.ts` covers the blank-glob rejection, the add/remove round trip, the default-mode badge, and the attribution list rendering the rule name. `permission-policy.test.ts` (protocol) and `relay.test.ts` cover the wire shapes and blind routing.

## 0.6.0

### Minor Changes

- e6c44d0: Peers announce a build identity alongside the protocol version, and a build mismatch is now visible on a node's own row instead of staying invisible until someone SSHes in and reads process start times (issue #655)

  On 2026-08-04 my resident node had been running since 29 July, across roughly fifty merged PRs including wire-level changes, and it connected to a freshly deployed relay without a word. That is the check working as designed and the design being too coarse: PROTOCOL_V1 has been 1 since the beginning and bumps only on a breaking wire change, so two peers built a week apart both announce it and shake hands happily while silently disagreeing about what several fields mean.

  `initialize`/`initialize_result` now carry an optional `buildIdentity` (package.json version plus, when honestly recoverable, the commit): a node reads its own git HEAD at startup (it runs unbundled from a checkout via tsx, so this is free, no new build step), and the relay reads `LOOMBOX_BUILD_COMMIT` in production (passed through from the exact `$SHA` deploy-prod.sh already writes to DEPLOYED.json) or falls back to git rev-parse in dev. Both fields are additive and optional; a peer that predates this change still connects exactly as before.

  The relay records each connected node's build identity and exposes it on `target_list` entries (`build`), mirroring how `reachable` already works: live-connection-derived, absent for an offline node or one that predates the field. `buildIdentityMismatch` in `@loombox/protocol` is a pure equality/absence check, never version parsing or ordering, matching this issue's own constraint that feature detection stays the protocol's job.

  The client shows a node's version on its own row (`TargetStatusView`) and adds a quiet "Behind" badge when it differs from what the relay itself is serving (`RelayClient.relayBuildIdentity`, from the client's own `initialize_result`). Three outcomes: same protocol and build stays silent, same protocol with a different build connects and gets the badge, an incompatible protocol is still refused via the existing `update_required` path, unchanged.

### Patch Changes

- 6f90259: Files and the terminal used to stop working permanently after a node restart,
  and blame the offline node for it. The eleven session handlers that guarded on
  `if (!bridge) return` (`prompt_inject`, `fs_list_request`, `terminal_open`,
  `terminal_input`, `terminal_resize`, `terminal_close`,
  `test_runner_config_get/set/detect`, `run_start`, `run_cancel`) never actually
  needed the live agent bridge except for `prompt_inject` — listing a directory,
  opening a terminal, and running a saved command only ever touched the session
  record and its target. Ten of the eleven now resolve that record straight from
  `SessionManager`, so they keep working on a session reloaded `'disconnected'`
  after a restart exactly as well as on a live one; `prompt_inject` still can't
  reach an agent that no longer exists, and stays a logged no-op (no reply
  channel exists for it to answer on).

  Widens the wire's `session_status` vocabulary with `'disconnected'`
  (protocol-side, alongside the existing `'queued'`/`'starting'`) and pushes it
  on every reconnect for a node's own disconnected sessions, so the client can
  finally tell a session apart from a live one: the session row shows a
  "Disconnected" badge and the composer disables itself with an explanation,
  instead of offering a prompt that can never be delivered.

- 9b5f66a: Fix the node dropping the config_option wire message, so changing model or thinking effort never reached the agent (issue #718)

  This is the last of three gaps in the same chain. #705 seeded the config-option catalogue from session/new so the pickers had something to show. #707 fixed AcpClient.setConfigOption to send and read the real ACP wire shape. Neither mattered on their own: RelayClient.setConfigOption sent a real config_option wire message, the relay routed it to the owning node correctly, and NodeDaemon.handleInbound hit its default case and dropped it. The comment said so outright. So the only thing that ever happened was the client's own optimistic guess at the new value, which the next real config_options push from the agent would silently revert.

  NodeDaemon.handleInbound now handles config_option: it calls through to the session's live AgentSession.setConfigOption (a new method, delegating to AcpClient.setConfigOption), gated on the same lease check prompt_inject uses for an ssh: session. I confirmed the wire message's existing {category, optionId} shape needed no changes: #707 already resolves configId/type from the session's own catalogue entry.

  A rejected set has to reach the user, not die in a console.warn. There was no wire shape to carry that, so I added one: config_option_result, a new node-to-client reply carrying outcome: 'ok' | 'error' plus the agent's own rejection message, correlated by category rather than a request id (config_option never had one, and category is the natural key every config-option store in this codebase already groups on). Fanned out to a session's subscribed clients exactly like fs_list_response.

  I dropped the client's optimistic update rather than keep and reconcile it. With a real round trip, the agent's own config_options push is what actually updates the picker, so there is no local guess left to ever have to revert on a rejection. RelayClient now tracks which categories it has an outstanding config_option for, so it can tell its own pending request apart from a sibling device's, and publishes a ConfigOptionErrorNotice (mirrors the existing PermissionStaleNotice) when the agent refuses.

  A config_option for a session with no live agent (reloaded 'disconnected' after a restart, a real state since #702) now answers honestly with config_option_result: error instead of being silently dropped.

  Verified against a real omp acp binary through a real node: set the model, set the thinking effort, read both back off the agent's own config_options push, and confirmed a real rejection ("Unknown ACP model: ...") reaches config_option_result. Added a node-level test driving the real config_option wire message; reverted the handler and watched it fail with the exact old symptom before restoring the fix.

## 0.5.1

### Patch Changes

- 35f3924: Tracker records are addressed by project, not by session, so a project's tracker
  is readable when no agent session is running for it. Adds a project resource key
  to the AMK key tree (`['project', accountId, projectPath]`), re-addresses the
  four tracker record messages to `nodeId` + `projectPath`, and makes the node
  answer every request it receives rather than dropping unanswerable ones.

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
