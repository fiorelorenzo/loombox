# @loombox/providers-core

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
