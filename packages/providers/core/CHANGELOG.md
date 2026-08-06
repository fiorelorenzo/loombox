# @loombox/providers-core

## 0.4.0

### Minor Changes

- f2d51ee: Curated catalogue of known-good ACP agents, one click instead of a command line (D1-3 second half, issue #749)

  `@loombox/providers-core`: a new `agent-catalogue.ts` (browser-safe, exported from both `.`/`./browser`) mirroring `mcp-presets.ts`'s exact pattern — `AGENT_CATALOGUE`, a small list of `AgentCatalogueEntry` (a blurb, a literal `CustomAgentRecordV1`-shaped `config`, and a `verification` record naming the exact version checked, the date, and the doc URL read), plus `instantiateAgentCatalogueEntry` (the one path from an entry to a real record, routed through the same `customAgentRecordV1` validator a hand-typed custom agent goes through). Ships two entries verified straight from their own docs: Gemini CLI (`gemini --acp`, `@google/gemini-cli@0.54.0`) and Qwen Code (`qwen --acp`, `@qwen-code/qwen-code@0.21.6`) — Claude Code and Codex are already registered providers, so they're not catalogued. `isAgentCatalogueEntryStale`/`agentCatalogueEntryStaleAt` turn "nobody re-verified this in a while" into a loud failure two ways: `agent-catalogue.test.ts` fails the day any entry crosses its own staleness window, and `instantiateAgentCatalogueEntry` itself throws `StaleAgentCatalogueEntryError` for an already-stale entry instead of silently handing back a possibly-wrong invocation. Convenience only, never a second trust tier: the node's own allowlist (`custom-agent.ts`, issue #748) is unchanged and untouched by any of this.

  `@loombox/web`: `custom-agent-store.ts` grew `addCustomAgentFromCatalogueEntry` (the catalogue counterpart of `mcp-server-store.ts`'s `addMcpServerFromPreset` — expands an entry via `instantiateAgentCatalogueEntry` and adds it through the exact same `addCustomAgent`). `NewSessionDialog`'s custom-agent section now leads with a "Quick-add from the curated catalogue" row: one button per `AGENT_CATALOGUE` entry, its verified-against version/date shown as a visible badge (not just a source comment), and a stale entry rendered as a danger badge instead of a normal one. Picking an entry pre-fills and selects it exactly like a hand-typed custom agent, then — when the injected client implements the new optional `NewSessionClient.probeCustomAgent` — immediately probes it against the project's own node/target and shows, in plain language, whether this specific node has actually allowlisted the command (`not on this node's allowlist yet…`) or is ready to run. The probe never gates the add itself: picking a catalogue entry always succeeds client-side, exactly like typing the same command by hand would.

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

- 757fa0e: Per-project scoped secret/env injection for agent execution (issue #258): a project can declare env vars its spawned agent process gets at start, each either a literal value or a reference to a node-local secret by name — resolved and injected only on the executing node, never sent to the relay or a client.

  - `@loombox/providers-core`'s `project-env.ts` mirrors `mcp-secret-grants.ts` (issue #189): `ProjectEnvVarDecl`, a per-secret `ProjectEnvGrantStore` (deliberately separate from `McpSecretGrantStore` — direct agent-env injection is a distinct trust boundary from an MCP server grant), and `resolveProjectEnv`, which fails fast on an ungranted/missing secret before returning anything.
  - `@loombox/protocol`'s `sessionPrivateMetaV1.projectEnvDecls` carries a client's declared list inside the same encrypted envelope as `title`/`projectPath`/`mcpServerConfigs`.
  - `@loombox/node`'s `NodeProjectEnvManager` persists only the grant ACL and reuses `NodeMcpSecretManager`'s existing keyring-backed secret-value storage rather than a second store, so a secret set once is usable by both an MCP server grant and direct env injection. `NodeDaemon` resolves it alongside `mcpServers` at session start, in the same before-any-worktree preflight path that already fails clearly on a bad MCP grant — a missing/ungranted secret now gets the identical treatment (a minimal `session_announce` plus `session_status: 'error'` naming the env var and secret). `ssh:` targets refuse a declared env var outright for now (the sandboxing dependency, issue #257, is still open) rather than silently starting an agent missing it.
  - `@loombox/supervisor`'s `AgentSupervisor.start()` gains an `env` option, merged into the provider's own `spawnConfig.env` before spawning — never sent anywhere but the local `child_process.spawn()` call.
  - `@loombox/web` gets `project-env-store.ts` (client-side declaration CRUD, mirrors `mcp-server-store.ts`) and `ProjectSecretsPanel.svelte`, mounted in the Config panel next to MCP servers; `RelayClient.createSession()` and `NewSessionDialog` forward the declared list on every session creation, the same way `mcpServerConfigs` does.

### Patch Changes

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

- ae1498a: The client now resyncs on reconnect, not only on a session's first-ever subscribe (issue #729): a dropped socket, a laptop sleep, or a page reload all recover whatever the relay buffered while disconnected, instead of losing it silently.

  - `@loombox/providers-core`: `TranscriptItem` gains a `gap` variant (`TranscriptGapItem`) and a new `reduceResyncGap` reducer — a relay `resync_marker` (`dropped: true`) becomes a visible, idempotent-by-range gap row in the transcript instead of a silent skip.
  - `@loombox/web`: `RelayClient` tracks the highest `session_update.seq` applied per session and sends `resync_request(sinceSeq: <that seq>)` on every successful `session_resume` ack — first subscribe (`sinceSeq: 0`, #772's existing path, unchanged) and every reconnect alike, guarded to once per (session, connection) so a first-subscribe's own retry storm doesn't fire it repeatedly. A live delivery and a resync replay of the identical `seq` are deduped so the item is applied exactly once; per-session `session_update` application is now strictly ordered by receipt (not decrypt-completion order), so an older status/config replay can never regress a newer one already applied. `resync_marker` renders via a new `TranscriptGap` row in `TranscriptTimeline`.

- 1ae1def: Subagent and nested tool-call tree rendering (issue #200; spike #199).

  **What was checked before building anything (real runs, not inferred):**

  - **Claude Code**, driven live against the real `@agentclientprotocol/claude-agent-acp` v0.65.0 npx bridge on this devbox: a Task-tool subagent's own nested tool calls arrive with `_meta.claudeCode.parentToolUseId` pointing at the launching tool call's own id (which itself carries `_meta.claudeCode.subagent: true`) — regardless of whether the client opts into the `subagent-transcript` capability. That capability only gates whether the subagent's own message/thinking text is _also_ forwarded (2 `agent_message_chunk`s without it vs. 5 with it, in the same live run); it does not gate tool-call nesting.
  - **Codex**, source-verified against the published `@agentclientprotocol/codex-acp` (no live run possible — no `codex` CLI/credentials on this devbox): a spawned subagent surfaces as one summarizing `spawnAgent`/`subAgentActivity` tool call carrying thread-scoped `_meta.codex.collaboration`/`_meta.codex.subagent` metadata, reusing the same `toolCallId` throughout. The subagent's own individual tool calls are never forwarded as separate ACP events, so there is nothing to attribute a `parentToolCallId` to today.
  - **`omp acp`** (oh-my-pi 17.2.9), driven live: a spawned subagent's tool activity is summarized inline inside the single spawning tool call's own `rawOutput` (`details.progress[].recentTools`), never emitted as separate ACP events, and the `subagent-transcript` capability is silently ignored.

  **What shipped, given that:**

  - `AcpClient.initialize()` now advertises `clientCapabilities._meta['subagent-transcript'] = true` (harmless for a provider that doesn't recognize it, verified against both `omp acp` and the Claude bridge).
  - `@loombox/providers-claude`'s `claudeProviderModule.enrich()` promotes a real `_meta.claudeCode.parentToolUseId` onto `parentToolCallId`, replacing the old no-op — the exact signal verified live above. `@loombox/providers-codex`'s stays a no-op; its doc comment now records the source-verified reason instead of "not yet confirmed".
  - `@loombox/providers-core`'s `transcript.ts` gains `computeToolCallNesting(items)`, a one-pass, per-`items`-reference lookup (`ReadonlyMap<id, { depth, parentTitle }>`) alongside the existing `ancestorChainForToolCall`. An orphan child — `parentToolCallId` set, but that id never arrived as its own item — resolves to `depth: 0`, identical to a genuine root call; a cycle is defused the same way. Exported from both `index.ts` and `browser.ts`.
  - `@loombox/web`'s `TranscriptTimeline.svelte` renders a nested tool call indented (capped at 3 levels; true depth is preserved in `data-nesting-depth` regardless) with a "nested in …" caption naming the resolved immediate parent, computed from the _full_ transcript on every `items` change — never from the windowed/mounted slice, so a child renders correctly even while its parent's own row is scrolled out of the mounted window (#755). `ToolCallRow`'s own markup is untouched; nesting is purely a wrapper affordance on the `<li>`, so the one-line row shape (v7 C1-1) is unaffected.

  Verification: `pnpm --filter @loombox/providers-core exec vitest run src/transcript.test.ts src/client.test.ts`, `pnpm --filter @loombox/providers-claude exec vitest run`, `pnpm --filter @loombox/providers-codex exec vitest run`, `pnpm --filter @loombox/web exec vitest run src/lib/components/TranscriptTimeline.test.ts src/lib/styles/tokens.test.ts src/lib/primitive-override-scope.test.ts`, `pnpm -r typecheck`, `pnpm exec eslint <changed files>`, `pnpm format:check`.

- 00e8789: Tool-call rows now carry a per-kind icon, elapsed time and, where honest, an attributed cost figure (Zed-parity C3-3, issue #744). The v7 C1-1 one-line shape is unchanged; this is only what shares that line.

  `@loombox/providers-core`'s `TranscriptToolCallItem` gains four new fields, computed purely by the reducer:

  - `startedAtMs` — set only from a real, non-terminal `tool_call` (never from a `tool_call_update`, so a call whose start this client never watched — e.g. one attached mid-session, or a resumed session's history replaying an already-finished call as one settled snapshot — never gets an invented start time).
  - `elapsedMs` — frozen once, the instant a later `tool_call_update` first carries a terminal status; `undefined` whenever `startedAtMs` is.
  - `costAtStartUsd` — internal bookkeeping, not for display.
  - `attributedCostUsd` — a client-side heuristic over `usage_update`'s session-level running cost total (it carries no `toolCallId` at all): the delta between session start and terminal update, shown only when this call was the sole active top-level tool call throughout its own lifetime and the total actually grew. Any other case — overlap with a sibling call, a nested/subagent call, no cost reporting at all — leaves it `undefined`, never a fabricated `$0.00`.

  `reduceTranscript`/`reduceSessionEvent` both take an optional `now` (default `Date.now()`) for deterministic tests, the same clock-injection convention `permission-queue-state.ts` already used.

  `@loombox/web`'s `apps/web/src/lib/components/icons/icon-paths.ts` adds six glyphs — `tool-read`, `tool-delete`, `tool-move`, `tool-search`, `tool-think`, `tool-fetch` — so every ACP `ToolKind` (`read`/`edit`/`delete`/`move`/`search`/`execute`/`think`/`fetch`/`other`) renders a distinct icon instead of `search`/`read`/`fetch`/`delete`/`move` all sharing the generic wrench; an unrecognized future kind still falls back to it via `$lib/tool-widgets.ts`'s new `toolKindIcon`. A new shared `ToolCallMeta` component (mirroring the existing `ToolCallGutter`/`ToolCallStatus` pattern) renders the elapsed-time/cost badges next to `ToolCallStatus` in `GenericToolRow` and every `tool-widgets/*` bespoke widget.

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

## 0.3.1

### Patch Changes

- 6f5dbe0: Fixed a real bug behind issue #660 (agent text appearing in one burst instead of streaming): `RelayClient` never resent `session_resume` after a reconnect, so a session's live updates silently stopped arriving once its connection dropped and came back (a slept laptop, a network blip, a heartbeat timeout) until the whole page reloaded. Now every session still marked as subscribed gets resumed again on every fresh handshake, first connect or reconnect alike.

  I also swapped the streaming test fixtures: `echo-acp-agent.mjs` used to send its two reply chunks synchronously, zero delay, which is exactly the shape that let a "batch and flush on turn end" regression pass every existing streaming test undetected. It now sends them with a real gap. I added a new `streaming-acp-agent.mjs` fixture that streams several thought chunks then several answer chunks over real time, and used it to write tests that assert the transcript grows while a turn is still open, not just that it's correct once the turn closes.

- 3e2e5f4: Fix AcpClient.setConfigOption sending the wrong request shape and reading the wrong response shape, so picking a model/thinking/mode option never actually worked against a real agent (issue #707)

  I spawned the real omp acp binary directly and confirmed setConfigOption was wrong on both sides of the call. The request sent {sessionId, category, choiceId}; the real agent rejects that outright with Invalid params and wants {sessionId, configId, value, type}. The response was read as result.options in this client's internal shape; the real field is configOptions, wire-shaped exactly like session/new's own catalog.

  The request fix needed more than a rename. configId is the wire entry's own id, not its category: a real agent's thinking option has id "thinking" but category "thought_level", and sending the category as configId gets rejected with "Unknown ACP config option: thought_level" (verified against the real binary). type is the entry's own select/boolean kind. Neither of those can be invented by a caller, who only ever supplies a category and a choice, so AcpConfigOption now retains id and type (both optional, since mapConfigOptions is the only producer with a reason to set them, and every hand-built AcpConfigOption elsewhere in the codebase predates this and has no reason to carry it). setConfigOption looks up the session's catalog entry for the given category and sources configId/type from there, throwing before sending anything if the catalog has no entry for that category rather than guessing. The unrecognized-category passthrough guarantee (issue #179) still holds end to end: nothing in setConfigOption branches on a specific category name.

  The response fix reuses mapConfigOptions, the single wire-to-internal translation point #705 added, instead of writing a second one.

  I also improved the rejected path while I was in there. A real agent's rejection carries the actual reason in error.data.details (e.g. "Unsupported value: X"), not in the generic top-level error.message ("Internal error"), and that detail was being dropped. handleResponse now folds it into the rejected Error's message, so a caller that only reads the exception text still learns why, not just that it failed.

  This is the third instance of the same class of bug in this area: #623 found it in the tool-call/plan mapping, #705 found it in the config-option catalogue read, this is the config-option write. The common thread is a fixture that mirrors our own wrong assumption instead of the real wire, so nothing catches it. Same fix applies here: config-acp-agent.mjs now speaks the real request/response shapes (and rejects an unrecognized configId/value like the real binary does), and the new tests are built off a recording of a real successful session/set_config_option round trip against the real omp acp binary (test/fixtures/omp-acp-set-config-option-response.json, no credentials, just a public catalogue and a mode change), same convention as #705's own recording.

  One thing I found and did not fix here: nothing in this codebase actually calls AcpClient.setConfigOption yet in production. apps/web's RelayClient.setConfigOption sends a config_option wire message, but packages/node's node-daemon.ts drops that message type entirely in its inbound switch's default case. So a rejected set has nowhere to surface today; that plumbing (node forwarding the request to setConfigOption and relaying success/failure back) is a real prerequisite gap, out of scope for this fix and bigger than #711 (which is presentation-only per its own issue text). Flagged to #711's author over IRC and as a comment on #707.

- ff47e23: Fix AcpClient discarding `session/new`'s config-option catalog (model/thinking/mode), the reason the composer's model and effort pickers never appeared (issue #705)

  `AcpClient.newSession` typed `session/new`'s result as a bare `{ sessionId: string }` and threw away everything else. A real agent's config-option catalog (model choices, reasoning effort, mode) arrives on `session/new`, not `initialize` — verified directly against the real `omp acp` binary: `initialize` carries no `configOptions` at all, `session/new` carries three (model: 26 choices, thinking: off/auto/low/medium/high/xhigh/max, mode: default/plan) plus a separate `modes` object.

  `session/new` now seeds the session's `ConfigOptionStore` from its own `configOptions`, falling back to `initialize`'s cached catalog only when `session/new` sends none (an agent that still answers at `initialize` instead). `initialize` itself is fixed too: it never actually carried config options in the shape this client assumed.

  The wire shape (`{id, name, category, type, currentValue, options: [{value, name, description}]}`) is unrelated to `AcpConfigOption`'s internal shape (`{category, current, choices: [{id, name}]}`) — a new `mapConfigOptions` in `client.ts` is the one place that translation happens now, for every source that can carry it: `initialize`, `session/new`, and the `config_option_update` notification (previously read a field, `options`, that doesn't exist on the real wire — ACP's real field is `configOptions` — a second instance of the exact bug `session/new` had, caught while auditing this). The mapping keys on the wire's `category` field, not `id` (a real agent's `thinking` option has `id: "thinking"` but `category: "thought_level"`), and preserves an unrecognized/future category untouched, per the passthrough guarantee `AcpConfigOption.category` was already typed for.

  `session/new`'s separate `modes` object (`{availableModes, currentModeId}`) describes the exact same selection as a `configOptions` entry whose `category` is `'mode'` — a real agent's response carries both. `mapConfigOptions` folds `modes` into that same entry rather than appending a second one, so `ConfigBar` renders one mode picker, not two; `modes` is used only as a fallback for an agent that sends the ACP-baseline field without also duplicating it into `configOptions`.

  The `config-acp-agent.mjs` test fixture previously encoded the same invented shape as the bug (an internal-shaped catalog handed back from `initialize`), so the existing tests agreed with the bug rather than with ACP — the same failure mode #623 found in the tool-call/plan mapping. Fixed alongside the mapping: the fixture's `session/new` now sends a real wire-shaped catalog plus a duplicate `modes`, and a new test suite in `client.test.ts` drives `mapConfigOptions` directly off a recording of a real `omp acp` `initialize` + `session/new` exchange (`test/fixtures/omp-acp-session-new-response.json`, no credentials, just public capability metadata) rather than a hand-built fixture. Confirmed these tests fail against the pre-fix code (reverted `client.ts` to `HEAD` and reran).

  Checked and intentionally left alone, filed as its own follow-up: `session/set_config_option` is a separate, larger bug — the real binary rejects this client's `{category, choiceId}` request params entirely (`Invalid params`; it wants `{configId, value, type}`) and its response field is `configOptions` wire-shaped, not `options` internal-shaped. Different data on both sides of the call, not a mapping gap this changeset's mapper closes.

## 0.3.0

### Minor Changes

- 29da402: Validate decrypted session_update/permission_request payloads with Zod instead of casting them (issue #593)

  `apps/web`'s `relay-client.ts` opened every decrypted `session_update`/`permission_request` envelope with a bare `openJson<T>()` generic cast — nothing ever checked the JSON actually matched `AcpSessionWireEvent`/`PermissionRequestPayload`. `AcpToolCallUpdate.id` was declared `string` but could be `undefined` at runtime, the root cause behind #548 (patched there one reducer-level comparison at a time).

  `@loombox/providers-core` gets a new `acp-wire-schema.ts`: Zod schemas for `AcpTranscriptUpdate`'s five ACP-native kinds (message/thought chunks, `tool_call`/`tool_call_update`, `plan_update`, `usage_update`) plus the `permission_request` payload — the half of `AcpSessionWireEvent` this package owns. The other half, loombox's five invented session-lifecycle kinds, is validated by `@loombox/protocol`'s existing `sessionLifecycleEventV1` schema instead of a new duplicate, since that package already documents itself as their "one validated source of truth" and providers-core keeps zero workspace dependencies by design.

  `relay-client.ts` now parses (not casts) both payloads; a malformed one is dropped and logged before it ever reaches the transcript reducer or the permission queue. #548's reducer-level `id === undefined` guard stays in place as defense in depth, though it is no longer reachable through this path.

### Patch Changes

- 79f9f19: Fix AcpClient's tool_call/tool_call_update/plan wire mapping against the real ACP schema (issue #623)

  `AcpClient` read `update.toolKind` for a tool call's category. ACP's real field is `kind` (agentclientprotocol.com/protocol/v1/tool-calls). Against a real agent this was always undefined, so every tool call fell back to the generic row instead of its bash/edit/read widget. This is the same class of bug #248/PR #622 found in `usage_update`, so this fix is a full field-by-field audit of the mapping rather than a one-line patch, with the result of that audit below.

  Found and fixed, in `packages/providers/core/src/client.ts`:

  - `kind` (was read as `toolKind`): the reported bug. Every tool call's category was silently lost.
  - `toolCallId` (was read as `id`): ACP's `ToolCall`/`ToolCallUpdate` field is `toolCallId`, not `id`. Since `mapToTranscriptUpdate` returns `undefined` when this is missing, every real tool call was silently dropped from the transcript entirely, not just misclassified.
  - diff extraction: ACP has no top-level `diff` field on `ToolCall`/`ToolCallUpdate`. A diff is one `{type: 'diff', path, oldText, newText}` entry inside the `content` array (agentclientprotocol.com/protocol/v1/tool-calls#diffs). `client.ts` now scans `content` for that entry instead of reading a wire field that does not exist. This mattered for the acceptance bar too: the edit/write widget only activates when `diff` is present, so the diff-extraction fix and the `kind` fix both had to land for an edit tool call to actually reach its bespoke widget.
  - the plan notification's own discriminant was wrong: ACP sends `sessionUpdate: 'plan'`, and the mapping's switch checked `'plan_update'` (this client's own internal name for the same update, used nowhere on the wire). Every real agent's plan report was silently dropped. No fixture or hand-written test ever sent a real plan notification, so nothing had caught this until now.

  Checked and already correct: `sessionUpdate`/`messageId`/`content` for message chunks, `status`/`title`/`rawInput`/`locations`/`content` for tool calls, `entries`/`content`/`priority`/`status` for plan entries, and `used`/`size`/`cost` for `usage_update` (fixed by #248).

  Checked and intentionally left alone: `parentToolCallId` is not an ACP wire field at all, it is a value SPEC.md §5.5/§7.24 documents a provider's `enrich()` hook promoting from vendor `_meta` (v2 work, issue #184), so it is correctly always undefined off the wire today. `config_option_update`'s `options` field name and per-option shape also diverge from ACP's real `configOptions`/`SessionConfigOption`, but that is a separate, larger subsystem (a different data model, not a field rename) outside this issue's tool-call/plan scope, flagged for a follow-up rather than folded into this fix.

  The fixtures in `packages/providers/core/test/fixtures/` encoded the same invented `id`/`toolKind`/top-level-`diff` shapes as the bug, so the existing tests agreed with the bug rather than with ACP. Fixed alongside the mapping, plus new tests in `client.test.ts` that build ACP-shaped payloads (not fixture-shaped ones) and drive them through `mapToTranscriptUpdate` and `reduceTranscript` to prove a real `kind` and a real content-embedded diff reach the fields `apps/web`'s `resolveToolWidgetKind` routes on.

## 0.2.0

### Minor Changes

- fc2c12e: Fix the per-session usage meter and add a near-context-limit warning (SPEC §7.9, issue #248)

  The composer's context/cost meter (`ConfigBar.svelte`, previously wired up for the model/mode/reasoning-effort bar) is SPEC §7.9's live usage meter — this doesn't add a second one, it fixes and extends the one already there. Three real bugs, all in `@loombox/providers-core`, none visible from `ConfigBar.svelte`'s own diff:

  - `AcpClient` was reading a raw `usage_update` wire event for field names (`tokensUsed`/`contextWindow`/`costUsd`) that don't exist on ACP's real shape. The protocol's actual `UsageUpdate` is `{used, size, cost}` with `cost: {amount, currency} | null` (agentclientprotocol.com/protocol/v1/schema) — so the meter never actually populated against a real ACP agent. Fixed in `client.ts`'s wire mapping; a non-USD `cost.currency` is left unconverted (`costUsd: undefined`) rather than mislabeled as dollars.
  - `cost.amount` is documented as the session's running cumulative total, not a per-update delta — the reducer was summing it, double-counting every update after the first. `cumulativeCostUsd` now tracks the latest reported total (`Math.max` against the previous value, guarding only against an out-of-order delivery ever making it visibly shrink).
  - A subagent tool call's `usage_update` reports its own, much smaller context window. The reducer now freezes the parent's `tokensUsed`/`contextWindow` across a subagent-attributed update instead of letting it overwrite them (previously masked by a UI-side guard, which just traded "the meter shows the wrong number" for "the meter shows nothing" while the subagent tool call was in flight) — the percentage no longer bounces either way. The subagent's cost is still folded into the cumulative figure, since ACP's own cumulative total already includes it.

  The subagent/parent split has no protocol support — ACP's `usage_update` carries no tool-call linkage at all — so it stays a documented client-side heuristic (`UsageRecord.attributedToSubagent`'s doc comment in `transcript.ts` spells out what it keys on and the two known ways it can misfire).

  New: a near-context-limit warning on the meter itself, at the newly-exported `CONTEXT_NEAR_LIMIT_THRESHOLD` (80%) — grounded against real-world auto-compaction thresholds observed on Claude Code (reported anywhere from ~80% to ~95% depending on source/version), so the warning fires before the earliest point any of them might silently compact. Carried to assistive tech via a `.sr-only` span (the meter's percentage track stays `aria-hidden`).

  Cost stays whatever the agent process itself reports via ACP's `cost.amount` — there is no per-token price table anywhere in this repo, and none is added here; a provider that omits `cost` simply doesn't move the cumulative figure for that update rather than getting an invented number.

  No aggregate spend-over-time view (issue #249) and no spend caps (issue #251) ship here — those build on `cumulativeCostUsd`, not the other way around. The broader attention-inbox surfacing of a near-limit session (issue #250) is separate too; this issue's own acceptance only asked for the warning on the meter itself.

### Patch Changes

- d09e12b: Stop a tool call with no `id` from wearing the "awaiting permission" outline

  `+page.svelte` computed `awaitingPermission={permissionHead?.toolCall.id === item.id}`. With no permission in flight, `permissionHead` is `undefined` and the optional chain short-circuits to `undefined`; if the transcript item's own `id` is also `undefined`, the comparison is `undefined === undefined`, true, and the row painted the amber `outline: 2px solid var(--color-warning)` even though nothing was pending. `item.id` is reachable as `undefined` from real traffic: the transcript payload is opaque ciphertext to the protocol, and the client casts the decrypted JSON with `openJson<AcpSessionWireEvent>` rather than parsing it with Zod, so nothing rejects a `tool_call` that omits `id`. The comparison now short-circuits on `permissionHead !== undefined` first.

  The same shape turned up twice more in a sweep of every optional-chain/possibly-undefined equality comparison across the web client and its shared protocol reducer. `RelayClient.discardStalePermissionForToolCall` compared `request.toolCall.id === event.id`; a malformed `tool_call_update` with no `id` could match a pending permission request whose own `toolCall.id` was equally malformed (the paired `permission_request` payload goes through the same unvalidated cast), cancelling it and publishing a false "resolved on another device" notice. `@loombox/providers-core`'s `reduceToolCall` looked up an existing transcript row by `item.id === update.id`; two unrelated malformed tool calls with no `id` would merge into a single row, the second silently overwriting the first's title/status. Both now refuse to match when the incoming `id` is `undefined`, so a malformed event always ends up in its own row/no-op rather than colliding with an earlier one.

## 0.1.0

### Minor Changes

- 55161ed: Give `@loombox/providers-core` a browser-safe entry point (`@loombox/providers-core/browser`) and move `McpServerSecretMissingError` out of `client.ts` into `mcp-secret-grants.ts`, beside the logic that raises it. The barrel exports `AcpClient`/`PermissionQueue`/`ConfigOptionStore`, which extend Node's `EventEmitter`; `vite build` tree-shakes them away, but `vite dev` evaluates every module it serves, so the web app painted a healthy page and then died on hydration with `Cannot access "node:events.EventEmitter" in client code`. `apps/web` now imports the browser entry, and a test asserts nothing reachable from it imports a `node:` builtin.
- fcb76fc: Offer the agents a target can actually run, and fix what the forms ask. Nodes now probe each target's own PATH and announce which providers work there, so the agent picker is a real choice instead of a hardcoded one-option dropdown. Adds Codex and Oh My Pi as real providers alongside Claude Code. The new-session dialog leads with the starting prompt, no longer reshapes itself ten seconds after opening, and every form marks the one required field instead of labelling the four optional ones.
