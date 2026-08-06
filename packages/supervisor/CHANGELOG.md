# @loombox/supervisor

## 0.2.0

### Minor Changes

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

- ff1fb1e: Fork a session from any turn into a new one (issue #746, Zed-parity decision C6-2). The transcript up to that turn is copied into a brand-new session with its own worktree, seeded from the source's branch tip plus an overlay of the source's uncommitted and untracked files, so the fork's files match the transcript it starts from. The original session and its worktree are untouched: nothing here reverts anything, which stays C6-3's job and depends on #603.
- 7ad7274: Wire `@loombox/supervisor`'s `GitCheckpointStore` (issue #266) into a running session and the wire protocol (issue #603). `NodeDaemon` now takes an automatic checkpoint right before every turn's prompt reaches the agent — before the whole turn, not just its first tool call, since ACP `session/update` notifications are fire-and-forget and there is no request/response boundary this node could synchronously interpose on between "the agent decided to write" and "the write already happened"; before the turn is the earliest point this node can actually guarantee, and it strictly subsumes "before the first write". Best-effort: a checkpoint failure is logged and never blocks the turn itself.

  Four new v1 wire messages (`checkpoint_create`/`_list`/`_restore_preview`/`_restore`, each with its own reply carrying an `outcome: 'ok' | 'error'` — `_restore` also `'confirmation_required'`), routed/fanned out by the relay exactly like `test_runner_config_get`/`_set`/`_detect`, sealed under the session key so a checkpoint's label, commit graph, and restore outcome never reach the relay in the clear. `checkpoint_restore` requires an explicit `confirm: boolean`: an unconfirmed restore that would discard anything uncommitted answers `confirmation_required` with the same `RestorePreview` `checkpoint_restore_preview` surfaces, and never touches the worktree — the structural half of "a rollback that would discard uncommitted human edits must say so before it runs". It also refuses while the session's own agent is actively mid-turn, so a restore can never race a live write.

  Every checkpoint/preview carries `isWorkInPlace` (`Session.branch === ''`): the engine treats an isolated worktree and an in-place session identically, but only an in-place session's worktree is the user's actual project folder, so this is the signal a client needs to warn accordingly rather than guessing. An `ssh:`-target session gets a clear `errorType: 'unsupported_target'` instead of a confusing failure: the engine spawns `git` as a local child process, so a remote session's `worktreePath` is not reachable from this node at all. A session's checkpoint refs are deleted (`GitCheckpointStore.deleteAllCheckpoints()`) whenever `SessionManager.removeSession` forgets it, so hidden refs never accumulate in the user's repo.

  This is the blocker both #268 (the rollback confirmation UI) and #747 (rewind) were waiting on. Neither is built yet: #268 still needs the client list/create/confirm UI over this wire surface, and #747 still needs to map a turn to the checkpoint taken before it (this wiring already takes one checkpoint per turn boundary, labeled `auto: before turn <n>`, for exactly that) and its own transcript-truncation half.

  `GitCheckpointStore.checkpoint()` itself now issues its independent `git` reads in parallel and one call fewer, plus a single retry on a transient subprocess-spawn failure: measured at 45-90ms serial per checkpoint against a real repo with zero contention. The automatic per-turn checkpoint stays serial — `await`ed before `agentSession.prompt()`, and in `deliverPrompt` ahead of attachment resolution too — after running it concurrently via `Promise.all` was found to let a caller (a test's teardown, in practice) delete a session's worktree while `checkpoint()` was still writing into it, surfacing as `ENOTEMPTY` on otherwise-unrelated tests on a clean CI runner; a per-bridge queue still orders two turns' checkpoint attempts against each other so they never race the same worktree either way.

- Updated dependencies [f2d51ee]
- Updated dependencies [a0fb0a6]
- Updated dependencies [0c46b48]
- Updated dependencies [ae1498a]
- Updated dependencies [79f55e0]
- Updated dependencies [6d3ad95]
- Updated dependencies [6325366]
- Updated dependencies [757fa0e]
- Updated dependencies [1ae1def]
- Updated dependencies [00e8789]
  - @loombox/providers-core@0.4.0
  - @loombox/providers-claude@0.0.5
  - @loombox/providers-codex@0.0.5
  - @loombox/providers-ohmypi@0.1.4

## 0.1.3

### Patch Changes

- 9b5f66a: Fix the node dropping the config_option wire message, so changing model or thinking effort never reached the agent (issue #718)

  This is the last of three gaps in the same chain. #705 seeded the config-option catalogue from session/new so the pickers had something to show. #707 fixed AcpClient.setConfigOption to send and read the real ACP wire shape. Neither mattered on their own: RelayClient.setConfigOption sent a real config_option wire message, the relay routed it to the owning node correctly, and NodeDaemon.handleInbound hit its default case and dropped it. The comment said so outright. So the only thing that ever happened was the client's own optimistic guess at the new value, which the next real config_options push from the agent would silently revert.

  NodeDaemon.handleInbound now handles config_option: it calls through to the session's live AgentSession.setConfigOption (a new method, delegating to AcpClient.setConfigOption), gated on the same lease check prompt_inject uses for an ssh: session. I confirmed the wire message's existing {category, optionId} shape needed no changes: #707 already resolves configId/type from the session's own catalogue entry.

  A rejected set has to reach the user, not die in a console.warn. There was no wire shape to carry that, so I added one: config_option_result, a new node-to-client reply carrying outcome: 'ok' | 'error' plus the agent's own rejection message, correlated by category rather than a request id (config_option never had one, and category is the natural key every config-option store in this codebase already groups on). Fanned out to a session's subscribed clients exactly like fs_list_response.

  I dropped the client's optimistic update rather than keep and reconcile it. With a real round trip, the agent's own config_options push is what actually updates the picker, so there is no local guess left to ever have to revert on a rejection. RelayClient now tracks which categories it has an outstanding config_option for, so it can tell its own pending request apart from a sibling device's, and publishes a ConfigOptionErrorNotice (mirrors the existing PermissionStaleNotice) when the agent refuses.

  A config_option for a session with no live agent (reloaded 'disconnected' after a restart, a real state since #702) now answers honestly with config_option_result: error instead of being silently dropped.

  Verified against a real omp acp binary through a real node: set the model, set the thinking effort, read both back off the agent's own config_options push, and confirmed a real rejection ("Unknown ACP model: ...") reaches config_option_result. Added a node-level test driving the real config_option wire message; reverted the handler and watched it fail with the exact old symptom before restoring the fix.

- Updated dependencies [6f5dbe0]
- Updated dependencies [3e2e5f4]
- Updated dependencies [ff47e23]
  - @loombox/providers-core@0.3.1
  - @loombox/providers-claude@0.0.4
  - @loombox/providers-codex@0.0.4
  - @loombox/providers-ohmypi@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [79f9f19]
- Updated dependencies [29da402]
  - @loombox/providers-core@0.3.0
  - @loombox/providers-claude@0.0.3
  - @loombox/providers-codex@0.0.3
  - @loombox/providers-ohmypi@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [d09e12b]
- Updated dependencies [fc2c12e]
  - @loombox/providers-core@0.2.0
  - @loombox/providers-claude@0.0.2
  - @loombox/providers-codex@0.0.2
  - @loombox/providers-ohmypi@0.1.1

## 0.1.0

### Minor Changes

- 4f7dcd4: Actually wire the per-target provider probe. `main.ts` never passed `providerCandidates`, which defaults to an empty list and makes the probe a documented no-op, so every production target announced `providers: []` and clients correctly refused to create sessions on it. The candidate list now comes from `AgentSupervisor`'s own default provider set (`DEFAULT_PROVIDER_REQUIREMENTS`), so the advertised set and the spawnable set cannot drift.
- fcb76fc: Offer the agents a target can actually run, and fix what the forms ask. Nodes now probe each target's own PATH and announce which providers work there, so the agent picker is a real choice instead of a hardcoded one-option dropdown. Adds Codex and Oh My Pi as real providers alongside Claude Code. The new-session dialog leads with the starting prompt, no longer reshapes itself ten seconds after opening, and every form marks the one required field instead of labelling the four optional ones.

### Patch Changes

- Updated dependencies [55161ed]
- Updated dependencies [fcb76fc]
  - @loombox/providers-core@0.1.0
  - @loombox/providers-claude@0.0.1
  - @loombox/providers-codex@0.0.1
  - @loombox/providers-ohmypi@0.1.0
