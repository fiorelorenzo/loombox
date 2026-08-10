/**
 * Minimal ACP (Agent Client Protocol) wire types for the v0 core client.
 *
 * Grounded in the real ACP v1 baseline (SPEC.md §16, "Generic ACP fallback
 * tier... grounded in ACP baseline: ContentBlock::Text"): JSON-RPC 2.0
 * exchanged over a child process's stdio as newline-delimited JSON. Only the
 * subset v0 needs is modeled here (SPEC.md §12); `tool_call`/`tool_call_update`/
 * `plan_update`/`usage_update`/`session/request_permission` and the full
 * transcript reducer (SPEC.md §7.24) are explicitly out of scope for this
 * package until v1/v2 (issue #48).
 */

import type { SessionStatusV1 } from '@loombox/protocol';

/** The spawn recipe for launching a provider's ACP-speaking agent process. */
export interface AcpSpawnConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** ACP baseline ContentBlock, text variant (the only one v0 parses). */
export interface AcpTextContentBlock {
  type: 'text';
  text: string;
}

/** Any other ACP ContentBlock variant (image, resource, resource_link, ...), passed through untyped. */
export type AcpContentBlock =
  AcpTextContentBlock | { readonly type: string; readonly [key: string]: unknown };

export type AcpUpdateKind = 'agent_message_chunk' | 'user_message_chunk';

/**
 * A parsed content update, reduced by the append-by-`messageId` rule
 * (SPEC.md §7.24's baseline reducer, v0 subset: message chunks only).
 * `text` is the message's full text after this chunk was appended, not just
 * the chunk's own delta, so a late listener always sees the current value.
 */
export interface AcpUpdate {
  kind: AcpUpdateKind;
  messageId: string;
  text: string;
}

/** Emitted once a `session/prompt` turn completes (the request's response arrives). */
export interface AcpTurnEnd {
  messageId: string | undefined;
  stopReason?: string;
}

export interface AcpAgentInfo {
  name: string;
  title?: string;
  version: string;
}

/**
 * ACP's own `promptCapabilities` sub-object (SPEC.md §7.25 "image content in
 * an ACP prompt is a base64 content block"). All optional: absence means off,
 * not an error (issue #180's "missing optional field" acceptance).
 */
export interface AcpPromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

/**
 * ACP's own `sessionCapabilities` sub-object: each key's mere presence (even
 * an empty `{}`) means the agent supports that session-lifecycle affordance;
 * an absent key means it doesn't (SPEC.md §5.5: "session/resume + replay
 * ... session/list, and cancellation", "additional-directories, session
 * delete"). Field-for-field against the real ACP v1 `SessionCapabilities`
 * object (`@agentclientprotocol/sdk`'s own `zSessionCapabilities` schema,
 * confirmed against the installed `@agentclientprotocol/codex-acp@1.1.10`
 * and a real `omp acp` binary recording — issue #821;
 * `docs/research/codex-acp-completeness.md`,
 * `test/fixtures/omp-acp-session-new-response.json`). `fork` exists on the
 * real object too but nothing in this codebase reads it yet, so it's left
 * off rather than typed and ignored.
 */
export interface AcpSessionCapabilities {
  resume?: Record<string, unknown>;
  list?: Record<string, unknown>;
  close?: Record<string, unknown>;
  delete?: Record<string, unknown>;
  additionalDirectories?: Record<string, unknown>;
}

/**
 * The full set of optional affordances an agent may advertise at
 * `initialize` time (SPEC.md §5.5), field-for-field against the real ACP v1
 * `AgentCapabilities` object rather than an invented shape. Every field
 * optional, on the same "absent = off" rule.
 *
 * Issue #821 rewrote this interface after a build-time verification spike
 * (issue #182) found it declared five top-level fields real ACP v1 doesn't
 * have, cross-checked against `@agentclientprotocol/sdk`'s own
 * `zAgentCapabilities` schema and a real `omp acp` binary recording
 * (`docs/research/codex-acp-completeness.md`,
 * `test/fixtures/omp-acp-session-new-response.json`):
 * `additionalDirectories`/`sessionDelete` are real, but live nested under
 * {@link AcpSessionCapabilities} (`.additionalDirectories`/`.delete`), not
 * flat here — fixed by nesting. `mcpServerPicker`, `requestPermission` and
 * `plans` don't exist anywhere in the real schema, in any nesting, and
 * nothing in this codebase read the flags `deriveFeatureFlags` derived from
 * them — removed outright rather than kept as dead plumbing around a
 * capability that was never real.
 */
export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: AcpPromptCapabilities;
  sessionCapabilities?: AcpSessionCapabilities;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: AcpAgentInfo;
  authMethods?: unknown[];
  /**
   * The agent's advertised config-option catalog (model / mode / reasoning
   * effort / any future category), the source of truth per SPEC.md §7.24's
   * "Model, mode & reasoning effort" bullet. Seeds each session's own
   * `ConfigOptionStore` entry as it's created (issue #179's Notes: "ACP's
   * own `initialize` response is the source of the option list").
   */
  configOptions?: AcpConfigOption[];
}

/* -------------------------------------------------------------------------
 * v1: session lifecycle (SPEC.md §5.5 "session/new/session/resume + replay
 * ... session/list, and cancellation"; §7.22 "resume-on-reopen"; issue #176).
 * ---------------------------------------------------------------------- */

/** One entry of ACP `session/list`'s result — the sessions this agent process still holds. */
export interface AcpSessionSummary {
  sessionId: string;
  cwd?: string;
  title?: string;
}

/* -------------------------------------------------------------------------
 * v1: session/request_permission (SPEC.md §7.24 "Tool-call permissions";
 * §5.5 "core owns ... session/request_permission"; issue #178). Modeled on
 * the same `toolCall`/`options` shape a real ACP `RequestPermissionRequest`
 * carries (issue #178's acceptance: "expose the request's raw `toolCall`
 * (a `ToolCallUpdate`: title, rawInput, content, locations)").
 * ---------------------------------------------------------------------- */

/** The vocabulary ACP's own `options[]`/`kind` field uses (SPEC.md §7.24). */
export type AcpPermissionOptionKind =
  'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

/** The agent -> client `session/request_permission` request params. */
export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
}

/** The two outcomes a `session/request_permission` response can carry, per §7.3's "no longer applies" rule. */
export type AcpPermissionOutcome =
  { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

/* -------------------------------------------------------------------------
 * v1: config-option state (model / mode / reasoning effort; SPEC.md §7.24
 * "Model, mode & reasoning effort"; issue #179). One `AcpConfigOption` per
 * category; `category` is an open string (not a closed union) so an
 * unrecognized/future non-underscore-prefixed category survives untouched
 * rather than being dropped, per the issue's acceptance criteria. Provider/
 * agent choice itself is not modeled here at all — deliberately: an
 * `AcpClient` wraps exactly one already-spawned provider process, and the
 * API surface has no method that reassigns it, which is what makes it
 * "immutable once a session object exists" at the type/API level rather
 * than by convention (issue #179's last acceptance bullet).
 * ---------------------------------------------------------------------- */

export interface AcpConfigOptionChoice {
  id: string;
  name: string;
  /**
   * This choice's own help text (`SessionConfigSelectOption.description`;
   * issue #897) — e.g. "Auto-detect per prompt". Real, present data (a real
   * `omp acp` binary sends one for nearly every model/mode choice), not
   * hypothetical; `mapConfigOptions` (`client.ts`) is the only producer.
   * Rendered as `ui/Select`'s own existing per-option `hint` — no new UI
   * element, since that slot already existed for exactly this purpose and
   * simply never had a real caller feeding it choice-level help text.
   */
  description?: string;
  /**
   * The display name of the `SessionConfigSelectGroup` this choice belongs
   * to (issue #897), when the agent sent `options` as a grouped
   * `SessionConfigSelectGroup[]` list rather than a flat
   * `SessionConfigSelectOption[]` one — `undefined` for a choice from an
   * ungrouped list. Choices from the SAME group carry the identical string
   * and stay adjacent in `choices`' own order (`mapConfigOptions` flattens
   * group-by-group, never interleaving), so a renderer can fold consecutive
   * same-`group` choices under one heading by a single pass, without a
   * second nested shape every existing flat-array consumer of `choices`
   * (`config-option-resolution.ts`'s membership checks, `ConfigBar`'s
   * `.find`/`.map`) would otherwise have to learn.
   */
  group?: string;
}

export interface AcpConfigOption {
  category: string;
  current: string | undefined;
  choices: AcpConfigOptionChoice[];
  /**
   * The wire's own `configId` (`SessionConfigOption.id`) and `type`
   * (`'select' | 'boolean'`), needed to build a legitimate
   * `session/set_config_option` request (issue #707): `category` is NOT
   * interchangeable with the wire's `id` — a real agent's `thinking`
   * option has `id: "thinking"` but `category: "thought_level"`, and
   * sending `configId: "thought_level"` is rejected outright ("Unknown ACP
   * config option: thought_level", verified against the real `omp acp`
   * binary). `mapConfigOptions` (`client.ts`) is the only producer that
   * populates these; every other place that builds an `AcpConfigOption` by
   * hand (test fixtures across other packages, mostly) predates this and
   * has no reason to carry it, which is why both stay optional here rather
   * than widening the whole cross-package shape — `AcpClient.setConfigOption`
   * throws when they're missing instead of guessing `configId` from
   * `category`.
   *
   * Unlike `id`, `type` now also rides the browser-facing wire
   * (`@loombox/protocol`'s `acpConfigOptionV1`, issue #897): a `'boolean'`
   * option is a real switch, not a `<Select>` dropdown, and only
   * `ConfigBar` (client-side) can make that rendering choice — `id` has no
   * equivalent client-side consumer, so it stays server-only.
   */
  id?: string;
  type?: string;
  /**
   * This option's own help text (`SessionConfigOption.description`; issue
   * #897) — e.g. what the category as a whole controls, as opposed to
   * {@link AcpConfigOptionChoice.description}'s per-CHOICE help text.
   * Rendered as a native `title` tooltip on the popover's own section (the
   * same "explain via a native tooltip, not new chrome" convention
   * `ConfigBar`'s trigger already uses for its D4-3 source summary), never
   * a new UI element of its own.
   */
  description?: string;
}

/* -------------------------------------------------------------------------
 * v1: available-command catalog (SPEC.md §7.24's slash-command surface;
 * issue #741, built once for #743's composer picker and #754's MCP-prompt
 * commands). Mirrors the config-option catalog immediately above
 * field-for-field: a per-session, wholesale-replaced list this package's
 * own `AvailableCommandsStore` (`available-commands.ts`) owns, fed by
 * `AcpClient`'s `available_commands_update` handling, carried onto the
 * wire the same way `AcpConfigOption` already is.
 * ---------------------------------------------------------------------- */

/**
 * ACP's `AvailableCommand.input` sub-shape — `{hint}` is the only variant
 * ACP documents today (a short usage string like `<plan|scan|status>` for
 * a command that takes arguments; absent for one that takes none, verified
 * directly against a real `omp acp` binary). Its own named type rather than
 * inlined so a future ACP variant this client hasn't modeled yet still has
 * somewhere to land without reshaping `AcpAvailableCommand` itself.
 */
export interface AcpAvailableCommandInput {
  hint: string | undefined;
}

/**
 * One command the connected agent declared via `available_commands_update`
 * (issue #741). Deliberately not narrowed to exactly `name`/`description`/
 * `input`: unlike `AcpConfigOption.category` (a closed set of known VALUES
 * left open), the extensibility risk here is a whole ACP field this client
 * has never seen on the object itself, so `mapAvailableCommands`
 * (`client.ts`) spreads the wire entry through rather than reconstructing a
 * picked-fields object — the index signature below is what lets that
 * survive onto this type (and through the wire round trip via
 * `@loombox/protocol`'s `.passthrough()`ed `acpAvailableCommandV1`) rather
 * than being silently dropped, the same "never invent a second, narrower
 * catalog and never drop what you don't recognize" contract the
 * config-option catalog already carries, applied at the object-key level
 * instead of the category-value level since `AvailableCommand` has no
 * analogous closed-set field. Same passthrough convention `AcpContentBlock`
 * above already uses for an unmodeled ACP `ContentBlock` variant.
 */
export interface AcpAvailableCommand {
  name: string;
  description: string | undefined;
  input: AcpAvailableCommandInput | undefined;
  /** Set only for a command synthesized from an MCP server's own declared prompt (Zed-parity D5-2, issue #754) — that server's name, so a caller can attribute this row distinctly from an agent-native command and route its send through `mcp_prompt_get_request` instead of sending `/name ...` verbatim. `undefined` for every ordinary agent-declared command. */
  mcpServer?: string;
  /** The MCP prompt's own declared argument schema (issue #754), carried alongside `input.hint`'s display-only string so a caller can build the `{name: value}` map an `mcp_prompt_get_request` sends, without re-deriving it from the hint text. Only ever set together with `mcpServer`. */
  mcpArguments?: AcpMcpServerPromptArgument[];
  readonly [key: string]: unknown;
}

/**
 * The two things ACP deliberately leaves to the client, per provider
 * (SPEC.md §5.5): the spawn config to launch that provider's agent in ACP
 * mode, and an `enrich()` hook that promotes a vendor's `_meta` fields onto
 * the core's fixed `AcpUpdate` shape. A module that adds neither (as every
 * v0 provider does) is a no-op `enrich` falling back to the generic tier.
 */
export interface AcpProvider {
  readonly id: string;
  spawnConfig(opts: { cwd: string }): AcpSpawnConfig;
  enrich(update: AcpUpdate): AcpUpdate;
}

/* -------------------------------------------------------------------------
 * v1: the fuller ACP update surface consumed by the transcript reducer
 * (SPEC.md §7.24 "One reducer, append-only by id"; §5.5 "core owns
 * tool_call/tool_call_update, plan_update, usage_update"). These are
 * additive to the v0 `AcpUpdate`/`AcpUpdateKind` types above, which
 * `AcpClient` keeps emitting unchanged; nothing here replaces them.
 * ---------------------------------------------------------------------- */

/** The three streamed-chunk kinds ACP v1 appends by id (SPEC.md §7.24). */
export type AcpMessageChunkKind =
  'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk';

/**
 * A single streamed chunk. `text` is this chunk's own delta (the piece ACP
 * just sent), not the accumulated message, matching the real wire format;
 * the reducer is what appends deltas into a running item. `turnId` is a
 * client-assigned identifier for the in-flight turn this chunk belongs to
 * (ACP itself carries no turn id on the wire) — required because the
 * reducer scopes an item's identity by *turn + kind*, not raw `messageId`
 * alone, since a provider may reuse an id across a thought and a message
 * within the same turn (SPEC.md §7.24).
 */
export interface AcpMessageChunkUpdate {
  kind: AcpMessageChunkKind;
  turnId: string;
  messageId: string;
  text: string;
}

/** ACP v1's Diff shape: `{path, oldText, newText}` (SPEC.md §7.24; `changes[]`/`operation` is v2-only). */
export interface AcpDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

/** The generic-fallback tool-call category (SPEC.md §7.24's tier-2 `ToolKind`-driven row; the real ACP v1 `zToolKind` enum has ten members — issues #822/#272). */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * `tool_call` (creates) and `tool_call_update` (mutates in place) share this
 * shape; every field but `kind`/`id` is optional so an update can carry only
 * what changed (e.g. a status flip with no new diff) and the reducer merges
 * it over the existing entry rather than clobbering fields the update didn't
 * mention. `parentToolCallId` is the field a provider's `enrich()` hook
 * promotes from a vendor `_meta` (e.g. Claude's `_meta.claudeCode.
 * parentToolUseId`, SPEC.md §5.5) to mark a nested/subagent tool call.
 */
export interface AcpToolCallUpdate {
  kind: 'tool_call' | 'tool_call_update';
  id: string;
  turnId?: string;
  title?: string;
  toolKind?: AcpToolKind;
  status?: AcpToolCallStatus;
  diff?: AcpDiff;
  rawInput?: unknown;
  content?: unknown;
  parentToolCallId?: string;
  /** File/line locations the tool call touches; rendered on a permission card's request (SPEC.md §7.24, issue #178). */
  locations?: unknown;
}

export type AcpPlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export interface AcpPlanEntry {
  content: string;
  status: AcpPlanEntryStatus;
  priority?: 'high' | 'medium' | 'low';
}

/** ACP replaces a plan's entire entry list on every update; never diffed client-side (SPEC.md §7.24). */
export interface AcpPlanUpdate {
  kind: 'plan_update';
  entries: AcpPlanEntry[];
}

/**
 * `usage_update` is session-level with no per-tool attribution on the wire
 * (SPEC.md §16) — it is NOT scoped to a particular tool call. Whether a
 * given update is attributable to a nested/subagent tool call is therefore
 * a client-side heuristic the reducer computes from its own state (see
 * `UsageRecord.attributedToSubagent` in transcript.ts), not a field ACP
 * itself sends.
 */
export interface AcpUsageUpdate {
  kind: 'usage_update';
  sessionId: string;
  tokensUsed?: number;
  contextWindow?: number;
  costUsd?: number;
}

/** The full v1 update surface the transcript reducer consumes (SPEC.md §7.24/§5.5). */
export type AcpTranscriptUpdate =
  AcpMessageChunkUpdate | AcpToolCallUpdate | AcpPlanUpdate | AcpUsageUpdate;

/* -------------------------------------------------------------------------
 * v1: session-lifecycle wire events (SPEC.md §7.13's attention states, §7.24's
 * status badge / model-mode-effort bar / turn-settling bullets, §8's
 * relay-blind boundary; issues #126/#128/#149). Unlike the `AcpTranscriptUpdate`
 * kinds above (raw ACP `session/update` passthrough), these six are
 * loombox's own invention, synthesized at `@loombox/node` from the
 * supervisor's `AgentSession` attention/turn-lifecycle state and sealed into
 * the *same* `session_update` encrypted envelope a transcript chunk already
 * rides — never a new clear relay message. Mirrored field-for-field (not
 * imported) from `@loombox/protocol`'s `session-events.ts`, the same
 * mirrored-not-shared pattern already used elsewhere across the encryption
 * boundary in this codebase; see that module's doc comment for the full
 * rationale. The one exception is `AcpSessionStatus` itself, just below:
 * this package already carries a real `@loombox/protocol` workspace
 * dependency (`agent-catalogue.ts`'s `CustomAgentRecordV1`), so issue #636
 * made it an actual re-export of `SessionStatusV1` rather than a second,
 * independently-maintained copy of the same nine-value list.
 * ---------------------------------------------------------------------- */

/**
 * A session's current status vocabulary — a re-export of `@loombox/
 * protocol`'s `SessionStatusV1`, not a second declaration of the same
 * list (issue #636). Before that fix this was its own five-value union
 * ('working'/'awaiting_input'/'permission_required'/'error'/'exited',
 * mirroring `@loombox/supervisor`'s `AttentionStatus`) while the wire
 * `SessionStatusV1` had grown four more values with no live-agent
 * counterpart — `'queued'`/`'starting'` (issues #252, #516), `'disconnected'`
 * (#702), `'paused'` (#251) — so every client-side consumer either cast
 * past the mismatch or keyed its own map off the wider protocol type
 * directly. `SessionStatusV1` is authoritative here: it is what the wire
 * actually carries, and `AttentionStatus` (the ACP-native, live-agent-only
 * subset with no `'queued'`/`'starting'`/`'disconnected'`/`'paused'`
 * concept) stays its own, deliberately narrower type — this alias is
 * about matching the wire, not the agent's own attention state.
 */
export type AcpSessionStatus = SessionStatusV1;

/** A session's current status, pushed whenever it transitions (SPEC.md §7.13/§7.24). `reason` is set for `'error'` (issue #730) — a spawn that failed or timed out — and, since issue #271, for a mid-session `'exited'` too: the process's own exit code, in words a user can read. */
export interface AcpSessionStatusEvent {
  kind: 'session_status';
  status: AcpSessionStatus;
  updatedAt: string;
  reason?: string;
}

/** The session's complete config-option catalog, pushed as a full wholesale replacement (SPEC.md §7.24; issue #149). */
export interface AcpConfigOptionsEvent {
  kind: 'config_options';
  options: AcpConfigOption[];
}

/** Same shape as {@link AcpConfigOptionsEvent}, for the distinct *unprompted* case — the agent changed its own config without the user asking (SPEC.md §7.24; issue #149's "two missing acceptance bullets"). */
export interface AcpConfigOptionUpdateEvent {
  kind: 'config_option_update';
  options: AcpConfigOption[];
}

/** The session's complete, agent-declared command catalog (`/`-command discovery; SPEC.md §7.24; issue #741), pushed as a full wholesale replacement whenever the agent (re)declares it — ACP has no per-command patch notification, only a full re-send, same "always the complete current set" contract {@link AcpConfigOptionsEvent} already carries. */
export interface AcpAvailableCommandsUpdateEvent {
  kind: 'available_commands_update';
  commands: AcpAvailableCommand[];
}

/** A new turn began (SPEC.md §7.24's turn-lifecycle bullet; issue #128). */
export interface AcpTurnStartedEvent {
  kind: 'turn_started';
  turnId: string;
}

/** A turn settled, deterministically (SPEC.md §7.24; issue #128's idle-timeout gap) — `stopReason` carries ACP's own `session/prompt` response field verbatim when the agent supplied one. */
export interface AcpTurnEndedEvent {
  kind: 'turn_ended';
  turnId: string | undefined;
  stopReason: string | undefined;
}

/** The fixed, closed vocabulary the node classifies an MCP server failure into (issue #750, D2-2) — see `AcpMcpServerStatusEvent`'s own doc comment for why this differs from `AcpConfigOption`'s open `category` string. */
export type AcpMcpServerFailureCategory = 'missing_binary' | 'handshake_failed' | 'secret_missing';

/**
 * One MCP server's outcome, as reported inside an {@link
 * AcpMcpServerStatusEvent}. `category`/`reason` are set only for
 * `ok: false`. `disabled` (issue #794) is `true` only when this exact
 * failure was the third consecutive one and the node just auto-disabled
 * its OWN config-store record for this server as a direct result — see
 * `mcpServerStatusEntryV1`'s own doc comment (`@loombox/protocol`) for
 * why a client-declared server's repeated failure never sets it.
 */
export interface AcpMcpServerStatusEntry {
  name: string;
  ok: boolean;
  category?: AcpMcpServerFailureCategory;
  reason?: string;
  disabled?: boolean;
}

/**
 * Pushed once a session's effective MCP server set has actually been
 * attempted against the agent (SPEC.md §7.7/§7.17; issue #750, D2-2) —
 * never for a session with no configured servers at all. Lists every
 * server that failed to start, by name and reason, so a session never
 * opens with quietly fewer tools than its configuration promised. A
 * server that started fine is never listed here.
 */
export interface AcpMcpServerStatusEvent {
  kind: 'mcp_server_status';
  servers: AcpMcpServerStatusEntry[];
  updatedAt: string;
}

/** The full set of session-lifecycle payloads (SPEC.md §7.13/§7.24), discriminated on `kind`. */
export type AcpSessionLifecycleEvent =
  | AcpSessionStatusEvent
  | AcpConfigOptionsEvent
  | AcpConfigOptionUpdateEvent
  | AcpAvailableCommandsUpdateEvent
  | AcpTurnStartedEvent
  | AcpTurnEndedEvent
  | AcpMcpServerStatusEvent
  | AcpMcpServerPromptsEvent;

/** One argument an MCP prompt declared (MCP's own `PromptArgument` shape — mirrors `@loombox/protocol`'s `mcpServerPromptArgumentV1`). `required` is a display/best-effort-mapping hint only; the MCP server itself is the actual enforcement point (a missing required argument surfaces as `mcp_prompt_get_response`'s `outcome: 'error'`). */
export interface AcpMcpServerPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** One prompt one MCP server declared via `prompts/list` (issue #754) — name, description and argument schema, never the rendered content itself (that's `prompts/get`, fetched live per-selection through `mcp_prompt_get_request`). */
export interface AcpMcpServerPrompt {
  name: string;
  description?: string;
  arguments?: AcpMcpServerPromptArgument[];
}

/** One MCP server's declared prompt catalogue, keyed by that server's own name (the same `name` {@link AcpMcpServerStatusEntry} reports against). */
export interface AcpMcpServerPromptsEntry {
  name: string;
  prompts: AcpMcpServerPrompt[];
}

/**
 * Pushed once per session, right alongside `mcp_server_status` (Zed-parity
 * D5-2, issue #754), after this session's launched MCP servers' own
 * `prompts/list` has actually been read. Only a server that both started
 * AND declared at least one prompt is listed here — a server with no
 * prompts contributes nothing, and an unreachable server never breaks this
 * for the others (see `@loombox/protocol`'s `mcpServerPromptsEventV1` doc
 * comment for the full "ride the same shape as `mcp_server_status`"
 * reasoning).
 */
export interface AcpMcpServerPromptsEvent {
  kind: 'mcp_server_prompts';
  servers: AcpMcpServerPromptsEntry[];
  updatedAt: string;
}

/**
 * Everything that can travel inside one `session_update` encrypted envelope
 * (SPEC.md §7.24/§8) — every ACP transcript-reducer update kind, plus
 * loombox's own session-lifecycle signals. This is the type `@loombox/node`
 * seals and `apps/web`'s `relay-client.ts` opens; `reduceSessionEvent`
 * (`transcript.ts`) is the reducer over this wider union.
 */
export type AcpSessionWireEvent = AcpTranscriptUpdate | AcpSessionLifecycleEvent;

/* -------------------------------------------------------------------------
 * v1: image hand-off content blocks (SPEC.md §7.25 "Hand off to the agent";
 * issues #157/#159). Both are real ACP baseline `ContentBlock` variants, not
 * loombox inventions: `image` carries inline base64 bytes, `resource_link`
 * points at a resource the agent reads itself (here, a supervisor-owned temp
 * file). Modeled as their own named types (rather than left folded into the
 * catch-all `AcpContentBlock` union) because both adapter packages build and
 * assert on them directly.
 * ---------------------------------------------------------------------- */

/** ACP baseline `ContentBlock::Image` — inline base64 bytes, no filesystem round-trip (SPEC.md §7.25). */
export interface AcpImageContentBlock {
  type: 'image';
  /** Base64-encoded image bytes. */
  data: string;
  /** Always the server-side *sniffed* mime type, never a client-declared one (SPEC.md §7.25). */
  mimeType: string;
}

/** ACP baseline `ContentBlock::ResourceLink` — a reference to a resource the agent reads itself (SPEC.md §7.25). */
export interface AcpResourceLinkContentBlock {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

/**
 * The content blocks `AcpClient.prompt()` accepts beyond its required text
 * block (SPEC.md §7.25 "Hand off to the agent"; issue #158): an inline
 * base64 image, or a `resource_link` pointing at a supervisor-owned temp
 * file for an agent/format that can't take the inline path. Named here
 * (rather than folded into the catch-all `AcpContentBlock`) because
 * `AcpClient.prompt()`'s signature asserts on it directly.
 */
export type AcpPromptContentBlock = AcpImageContentBlock | AcpResourceLinkContentBlock;

/* -------------------------------------------------------------------------
 * v1: configured MCP servers, fed into `session/new` (SPEC.md §7.7 "configured
 * MCP servers feed the actual agent session"; §5.5 "session/new is a
 * core-owned ACP method"; issue #190). Grounded in the real ACP schema
 * (agentclientprotocol.com/protocol/schema)'s `McpServer` union: every
 * agent must support the `stdio` variant, `http`/`sse` are optional and
 * gated on the agent's own `initialize`-time `mcpCapabilities`. Modeled here
 * as its own named type (not folded into `AcpContentBlock`'s catch-all
 * pattern) because `AcpClient.newSession` validates and shapes it directly.
 * ---------------------------------------------------------------------- */

/**
 * One `name`/`value` pair — an env var for a `stdio` server, or an HTTP
 * header for `http`/`sse` (same shape ACP uses for both). `value: undefined`
 * marks a variable that names a required secret whose per-server grant
 * (issue #189, out of scope in this package) hasn't resolved yet — the
 * caller assembling this config is expected to leave it unresolved rather
 * than omit the variable entirely, so `AcpClient.newSession` can tell "this
 * server needs a secret it doesn't have" apart from "this server has no such
 * variable at all" and fail session creation with a clear, actionable error
 * instead of starting the agent silently without it (SPEC.md §7.7).
 */
export interface AcpMcpKeyValue {
  name: string;
  value: string | undefined;
}

/** The ACP `McpServer::Stdio` variant — the transport every agent must support. */
export interface AcpMcpStdioServerConfig {
  type?: 'stdio';
  name: string;
  command: string;
  args: string[];
  env?: AcpMcpKeyValue[];
}

/** The ACP `McpServer::Http` variant — gated on the agent's `mcpCapabilities.http`. */
export interface AcpMcpHttpServerConfig {
  type: 'http';
  name: string;
  url: string;
  headers?: AcpMcpKeyValue[];
}

/** The ACP `McpServer::Sse` variant — gated on the agent's `mcpCapabilities.sse`. */
export interface AcpMcpSseServerConfig {
  type: 'sse';
  name: string;
  url: string;
  headers?: AcpMcpKeyValue[];
}

/**
 * The effective, enabled MCP server set a caller (the project/global MCP
 * config surface, issue #187, out of scope here) hands to `AcpClient.
 * newSession` for one session — provider/adapter-supplied config, not a new
 * loombox wire message: it rides entirely inside the existing ACP `session/
 * new` call this client already makes.
 */
export type AcpMcpServerConfig =
  AcpMcpStdioServerConfig | AcpMcpHttpServerConfig | AcpMcpSseServerConfig;
