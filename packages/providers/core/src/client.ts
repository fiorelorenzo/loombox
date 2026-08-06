import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { deriveFeatureFlags } from './capabilities';
import type { AcpFeatureFlags } from './capabilities';
import { AvailableCommandsStore } from './available-commands';
import { ConfigOptionStore } from './config-options';
import { PermissionQueue } from './permission-queue';
import { McpServerSecretMissingError } from './mcp-secret-grants';
import type { PermissionResolveResult } from './permission-queue';
import type { ProviderRegistry } from './provider-registry';
import { createTranscriptState, reduceTranscript } from './transcript';
import type { TranscriptState } from './transcript';
import type {
  AcpAgentCapabilities,
  AcpAvailableCommand,
  AcpConfigOption,
  AcpDiff,
  AcpInitializeResult,
  AcpMcpServerConfig,
  AcpPermissionOptionKind,
  AcpPlanEntry,
  AcpPromptContentBlock,
  AcpSessionSummary,
  AcpSpawnConfig,
  AcpToolCallStatus,
  AcpToolKind,
  AcpTranscriptUpdate,
  AcpUpdate,
  AcpUpdateKind,
} from './types';

/** A spawned ACP agent's stdio, or a caller-supplied config to spawn one (issue #48). */
export type AcpChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** Constructor options wiring a provider module's `enrich()` hook into the v1 update pipeline (issue #181). Optional and additive: omitting it keeps every update a pure pass-through. */
export interface AcpClientOptions {
  registry?: ProviderRegistry;
  providerId?: string;
}

interface JsonRpcRequestOut {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotificationIn {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcRequestIn {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

type JsonRpcInbound = JsonRpcSuccess | JsonRpcFailure | JsonRpcNotificationIn | JsonRpcRequestIn;

/**
 * The wire shape of a `session/update` notification's `update` object,
 * widened (additive to v0's narrower inline type) to cover every
 * `sessionUpdate` kind the v1 transcript reducer and config-option/
 * available-command stores understand: message/thought chunks,
 * `tool_call`/`tool_call_update`, `plan`, `usage_update`,
 * `config_option_update`, and `available_commands_update`.
 *
 * Field-by-field audit against the real ACP v1 schema
 * (agentclientprotocol.com/protocol/v1/schema,
 * agentclientprotocol.com/protocol/v1/tool-calls,
 * agentclientprotocol.com/protocol/v1/agent-plan — issue #623, the same
 * class of bug #248 found in `usage_update`):
 *  - `sessionUpdate`/`messageId`/`content` (message chunks): correct.
 *  - `toolCallId` (was `id`): ACP's `ToolCall`/`ToolCallUpdate` field is
 *    `toolCallId`, not `id` — every real tool call was silently dropped
 *    (`mapToTranscriptUpdate`'s `if (!update.id) return undefined` never
 *    matched a real agent's payload).
 *  - `kind` (was `toolKind`): ACP's field is `kind` — this is the bug
 *    #623 reports. `toolKind` stays the name of this client's OWN
 *    internal `AcpToolCallUpdate` field; `mapToTranscriptUpdate` does the
 *    wire-to-internal translation, same convention `usage_update` below
 *    already uses.
 *  - `diff`: ACP has NO top-level `diff` field on `ToolCall`/
 *    `ToolCallUpdate` — a diff is one `{type: 'diff', path, oldText,
 *    newText}` entry inside the `content` array
 *    (agentclientprotocol.com/protocol/v1/tool-calls#diffs). See
 *    `extractDiff` below; this client derives `diff` from `content`
 *    rather than reading a wire field that doesn't exist.
 *  - `status`/`title`/`rawInput`/`locations`/`content`: correct.
 *  - `rawOutput`: a real ACP field this client does not read — `content`
 *    already carries the tool's display-ready results and nothing
 *    consumes `rawOutput` today, so it's intentionally left off this
 *    interface rather than plumbed through unused.
 *  - `parentToolCallId`: this interface's own field never carries a real
 *    wire value — no real provider sends a bare, top-level
 *    `parentToolCallId` on `session/update`. It's declared here only so
 *    `mapToTranscriptUpdate` passes an (always-`undefined`-off-the-wire)
 *    slot through to `AcpTranscriptUpdate`, which a provider's `enrich()`
 *    hook then fills from its own vendor `_meta` shape — Claude Code's is
 *    `_meta.claudeCode.parentToolUseId` (issue #200; verified with a live
 *    run against the real npx bridge; `@loombox/providers-claude`'s
 *    `claudeProviderModule.enrich()` does the promotion). Not a bug: this
 *    mapping function deliberately never reads `_meta` itself — SPEC.md
 *    §5.5's whole point is that vendor `_meta` promotion is a provider
 *    adapter's job, not core's.
 *  - `entries` (plan): correct; ACP's `PlanEntry` `content`/`priority`/
 *    `status` fields also match this client's own `AcpPlanEntry` verbatim.
 *  - the `plan` vs `plan_update` notification **discriminant** itself was
 *    wrong too — see `mapToTranscriptUpdate`'s switch. Untested until
 *    #623: no fixture or hand-written payload ever sent a real plan
 *    notification, so this silently dropped every plan report.
 *  - `used`/`size`/`cost`: correct (fixed by #248/PR #622).
 *  - `options` (`config_option_update`): ACP's real field is
 *    `configOptions: SessionConfigOption[]`, wire-shaped the same as
 *    `session/new`'s own `configOptions` (`id`/`name`/`category`/
 *    `type: 'select'|'boolean'`/`currentValue`/`options: [{value, name,
 *    description}]`), unrelated to this client's own `AcpConfigOption`
 *    (`category`/`current`/`choices`). `mapConfigOptions` below is the one
 *    place this translation happens for every source (`initialize`,
 *    `session/new`, and this notification) — issue #705, closing the
 *    follow-up this comment used to flag.
 *  - `availableCommands` (`available_commands_update`): ACP's real field
 *    name, `[{name, description, input: {hint} | null}]` — see
 *    `mapAvailableCommands`'s own doc comment (issue #741).
 */
interface RawSessionUpdate {
  sessionUpdate?: string;
  messageId?: string;
  content?: unknown;
  toolCallId?: string;
  title?: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  rawInput?: unknown;
  parentToolCallId?: string;
  locations?: unknown;
  entries?: AcpPlanEntry[];
  // usage_update (issue #248): ACP's real wire shape is `{used, size, cost}`
  // (agentclientprotocol.com/protocol/v1/schema's `UsageUpdate`/`Cost`
  // types) — `used`/`size` are token counts, `cost` is `{amount, currency}`
  // (ISO 4217) or `null`, and `amount` is documented as the session's
  // TOTAL CUMULATIVE cost so far, not a per-update delta. These are NOT
  // `tokensUsed`/`contextWindow`/`costUsd` (an earlier version of this
  // interface invented those names without checking the schema, so the
  // meter never actually populated against a real agent) — `used`/`size`/
  // `cost` below are mapped into the internal `tokensUsed`/`contextWindow`/
  // `costUsd` names by `mapToTranscriptUpdate`, which is the one place that
  // translation happens.
  used?: number;
  size?: number;
  cost?: { amount?: number; currency?: string } | null;
  configOptions?: RawConfigOption[];
  availableCommands?: RawAvailableCommand[];
}

interface SessionUpdateParams {
  sessionId?: string;
  update?: RawSessionUpdate;
}

interface RequestPermissionParamsWire {
  sessionId?: string;
  toolCall?: RawSessionUpdate;
  options?: { optionId: string; name: string; kind: AcpPermissionOptionKind }[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface SessionState {
  /** keyed by `${kind}:${messageId}` so a provider reusing an id across kinds can't collide (SPEC.md §7.24). */
  buffers: Map<string, string>;
  lastAgentMessageId: string | undefined;
  /** v1: the running transcript reducer state for this session (SPEC.md §7.24), additive to the v0 fields above. */
  transcriptState: TranscriptState;
  /** v1: every enriched `AcpTranscriptUpdate` this client has seen for this session, in arrival order — what `replay()`/`getHistory()` serve a re-attaching consumer (issue #176). */
  history: AcpTranscriptUpdate[];
  /** v1: client-assigned turn id for whatever turn is currently active (a real prompt, or a resume's replay batch); ACP itself carries no turn id on the wire (SPEC.md §7.24). */
  currentTurnId: string;
  turnCounter: number;
}

/** The ACP protocol version this client negotiates (ACP v1 baseline, SPEC.md §16). */
const PROTOCOL_VERSION = 1;

/**
 * Advertised in `initialize`'s `clientCapabilities._meta` (issue #199/#200:
 * verified with a live run against the real `@agentclientprotocol/
 * claude-agent-acp` npx bridge — its own README: "Clients that can render
 * nested transcripts can opt in with `clientCapabilities._meta["subagent-
 * transcript"] = true`. The agent then forwards subagent text, thinking,
 * and tool calls, relating nested updates to the launching Agent/Task call
 * through `_meta.claudeCode.parentToolUseId`."). Nested TOOL CALLS were
 * observed forwarding regardless of this flag in that same live run — only
 * the subagent's own message/thinking stream is gated on it (silently
 * dropped otherwise) — but it costs nothing to always advertise: an agent
 * that doesn't recognize a `_meta` key ignores it (verified live against
 * both a real `omp acp` binary, which never even echoes it back, and the
 * Claude bridge, which does). `@loombox/providers-claude`'s
 * `claudeProviderModule.enrich()` is the piece that actually promotes
 * `_meta.claudeCode.parentToolUseId` once it arrives — this constant only
 * controls whether it's given the chance to arrive at all.
 */
const SUBAGENT_TRANSCRIPT_CAPABILITY_KEY = 'subagent-transcript';

/** Options accepted by `AcpClient.newSession` (issue #190). */
export interface NewSessionOptions {
  /**
   * The effective, enabled MCP server set for this session (SPEC.md §7.7).
   * Provider/adapter-supplied config, resolved (secrets included) by the
   * caller before reaching this client — never a new loombox wire message,
   * it rides entirely inside the existing ACP `session/new` call. Defaults
   * to an empty list, matching this client's pre-#190 behavior.
   */
  mcpServers?: AcpMcpServerConfig[];
}

/**
 * Every `stdio` env var / `http`/`sse` header across a configured MCP server
 * set must have a resolved (non-`undefined`) value before this client will
 * open a session with it (see `McpServerSecretMissingError`).
 */
function assertMcpServersResolved(servers: readonly AcpMcpServerConfig[]): void {
  for (const server of servers) {
    const pairs = server.type === 'http' || server.type === 'sse' ? server.headers : server.env;
    for (const pair of pairs ?? []) {
      if (pair.value === undefined) {
        throw new McpServerSecretMissingError(server.name, pair.name);
      }
    }
  }
}

function isSpawnConfig(value: AcpChildProcess | AcpSpawnConfig): value is AcpSpawnConfig {
  return typeof (value as AcpSpawnConfig).command === 'string';
}

function isSuccessOrFailure(msg: JsonRpcInbound): msg is JsonRpcSuccess | JsonRpcFailure {
  return 'id' in msg && msg.id !== undefined && ('result' in msg || 'error' in msg);
}

function isNotification(msg: JsonRpcInbound): msg is JsonRpcNotificationIn {
  return 'method' in msg && !('id' in msg);
}

/** An agent -> client request (e.g. `session/request_permission`, `fs/*`): has both `method` and `id`, but no `result`/`error` (that's what distinguishes it from a response to our own outbound requests). */
function isIncomingRequest(msg: JsonRpcInbound): msg is JsonRpcRequestIn {
  return 'method' in msg && 'id' in msg && msg.id !== undefined;
}

/**
 * A rejected JSON-RPC response's `error.data` is `unknown` per the spec,
 * but a real agent (verified against `omp acp`) always nests the
 * human-actionable reason at `data.details` (e.g. `session/set_config_option`
 * rejecting with `{code: -32603, message: 'Internal error', data: {details:
 * 'Unknown ACP config option: thought_level'}}`) — `handleResponse` folds
 * this into the rejected `Error`'s message so a caller isn't left with just
 * the generic top-level `message` (issue #707).
 */
function extractErrorDetails(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || !('details' in data)) return undefined;
  const { details } = data;
  return typeof details === 'string' ? details : undefined;
}

/**
 * ACP's real wire shape carries a tool call's diff (if any) as one
 * `{type: 'diff', path, oldText, newText}` entry inside its `content`
 * array — there is no top-level `diff` field on `ToolCall`/
 * `ToolCallUpdate` (agentclientprotocol.com/protocol/v1/tool-calls#diffs;
 * issue #623). Finds the first such entry and lifts it onto this client's
 * own top-level `AcpToolCallUpdate.diff` convenience field; `content`
 * itself is still passed through unchanged alongside it, so a consumer
 * wanting the full content array (not just the diff) still gets it.
 */
function extractDiff(content: unknown): AcpDiff | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const entry of content) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as {
      type?: unknown;
      path?: unknown;
      oldText?: unknown;
      newText?: unknown;
    };
    if (item.type !== 'diff') continue;
    if (typeof item.path !== 'string' || typeof item.newText !== 'string') continue;
    return {
      path: item.path,
      oldText: typeof item.oldText === 'string' ? item.oldText : null,
      newText: item.newText,
    };
  }
  return undefined;
}

/**
 * ACP's real config-option wire shape (`SessionConfigOption` at
 * agentclientprotocol.com/protocol/v1/schema), carried by `initialize`'s
 * result, `session/new`'s result, and a `config_option_update`
 * notification alike: `{id, name, category, type, currentValue,
 * options: [{value, name, description}]}`. Materially different from this
 * client's own internal `AcpConfigOption` (`types.ts`: `{category,
 * current, choices: [{id, name}]}`) — issue #705.
 */
interface RawConfigOptionChoice {
  value?: string;
  name?: string;
  description?: string;
}

interface RawConfigOption {
  id?: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: RawConfigOptionChoice[];
}

/**
 * ACP's separate `modes` sub-object, carried alongside `session/new`'s
 * `configOptions` (`{availableModes: [{id, name, description}],
 * currentModeId}`). `mapConfigOptions` below folds this into the SAME
 * `mode`-category entry a real agent's `configOptions` array also carries
 * — see that function's own doc comment for why.
 */
interface RawSessionModes {
  availableModes?: { id?: string; name?: string; description?: string }[];
  currentModeId?: string;
}

interface RawConfigCatalog {
  configOptions?: RawConfigOption[];
  modes?: RawSessionModes;
}

/**
 * Maps ACP's real config-option wire shape onto this client's internal
 * `AcpConfigOption` — the one place this translation happens, for every
 * source that can carry it (`initialize`, `session/new`, and a
 * `config_option_update` notification; issue #705). Exported for direct
 * unit testing against a recorded real response, same convention as
 * `mapToTranscriptUpdate` above.
 *
 * `category` (not `id`) is the mapping target for the internal
 * `category` field: a real agent's `id` and `category` can legitimately
 * differ (verified against a real `omp acp` binary — its `thinking`
 * option's `id` is `"thinking"` but its `category` is `"thought_level"`,
 * the axis `ConfigOptionStore`'s callers already group on), and `category`
 * is the open, future-proof field `AcpConfigOption` deliberately leaves as
 * a bare string rather than a closed union, so an entry whose `category`
 * this client has never seen still survives untouched here too (issue
 * #179's passthrough guarantee, preserved).
 *
 * `modes` (ACP's separate `{availableModes, currentModeId}` sub-object)
 * describes the exact same selection as a `configOptions` entry whose
 * `category` is `'mode'` — a real `omp acp` response sends both. Folding
 * `modes` into that same entry (rather than appending a second one) is
 * what keeps `ConfigOptionStore` — and therefore `ConfigBar` — from
 * rendering two mode pickers for one underlying selection. `modes` is
 * used only when `configOptions` has no `'mode'` entry at all, so an
 * agent that advertises just the ACP-baseline `modes` field (without also
 * duplicating it into `configOptions`, unlike omp) still gets one.
 *
 * Also carries the wire's own `id`/`type` through onto `AcpConfigOption.id`/
 * `.type` (issue #707): `AcpClient.setConfigOption` needs both to build a
 * `session/set_config_option` request the agent actually accepts, and
 * `category` cannot stand in for `id` (see `AcpConfigOption`'s own doc
 * comment) — this is the one place that data is available to capture, so
 * dropping it here would force `setConfigOption` to invent it later. The
 * `modes`-derived `mode` entry gets `id: 'mode'`, `type: 'select'`
 * synthesized: ACP's baseline mode axis has no per-option wire `id`/`type`
 * of its own to copy, and `configId: 'mode'` is confirmed accepted against
 * the real binary (this same recording's own `configOptions` entry for
 * `mode` has `id === category === 'mode'`).
 */
export function mapConfigOptions(wire: RawConfigCatalog | undefined): AcpConfigOption[] {
  const options: AcpConfigOption[] = [];
  for (const option of wire?.configOptions ?? []) {
    if (typeof option.category !== 'string') continue;
    options.push({
      category: option.category,
      current: option.currentValue,
      id: typeof option.id === 'string' ? option.id : undefined,
      type: typeof option.type === 'string' ? option.type : undefined,
      choices: (option.options ?? [])
        .filter(
          (choice): choice is RawConfigOptionChoice & { value: string; name: string } =>
            typeof choice.value === 'string' && typeof choice.name === 'string',
        )
        .map((choice) => ({ id: choice.value, name: choice.name })),
    });
  }

  if (wire?.modes && !options.some((option) => option.category === 'mode')) {
    const modeChoices = (wire.modes.availableModes ?? []).filter(
      (mode): mode is { id: string; name: string; description?: string } =>
        typeof mode.id === 'string' && typeof mode.name === 'string',
    );
    if (modeChoices.length > 0) {
      options.push({
        category: 'mode',
        current: wire.modes.currentModeId,
        id: 'mode',
        type: 'select',
        choices: modeChoices.map((mode) => ({ id: mode.id, name: mode.name })),
      });
    }
  }

  return options;
}

/**
 * ACP's real `AvailableCommand` wire shape (agentclientprotocol.com's
 * schema), carried by an `available_commands_update` notification's own
 * `availableCommands` field: `{name, description, input: {hint} | null}`,
 * verified directly against a real `omp acp` binary (issue #741; see
 * `test/fixtures/omp-acp-available-commands-update.json` for the
 * recording, trimmed from the real one). Named fields, not
 * `Record<string, unknown>` wholesale, so `mapAvailableCommands` stays
 * honest about what it actually validates; the index signature still lets
 * a field this interface hasn't named through, and `mapAvailableCommands`
 * spreads (not reconstructs) each entry so that field survives onto
 * `AcpAvailableCommand` rather than being read and then dropped.
 */
interface RawAvailableCommandInput {
  hint?: string;
  [key: string]: unknown;
}

interface RawAvailableCommand {
  name?: string;
  description?: string;
  input?: RawAvailableCommandInput | null;
  [key: string]: unknown;
}

/**
 * Maps ACP's real `available_commands_update` wire shape onto this
 * client's internal `AcpAvailableCommand[]` (issue #741) — the one place
 * this translation happens, exported for direct unit testing, same
 * convention as `mapConfigOptions` above. An entry missing a `name` is
 * dropped (there is nothing to key it by); everything else about an
 * entry — including a field this interface has never named — survives via
 * the `...raw`/`...raw.input` spreads, per `AcpAvailableCommand`'s own
 * "never drop what you don't recognize" doc comment.
 */
export function mapAvailableCommands(
  wire: RawAvailableCommand[] | undefined,
): AcpAvailableCommand[] {
  const commands: AcpAvailableCommand[] = [];
  for (const raw of wire ?? []) {
    if (typeof raw.name !== 'string') continue;
    commands.push({
      ...raw,
      name: raw.name,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      input:
        raw.input && typeof raw.input === 'object'
          ? { ...raw.input, hint: typeof raw.input.hint === 'string' ? raw.input.hint : undefined }
          : undefined,
    });
  }
  return commands;
}

/** Maps one wire `session/update` payload into the v1 transcript reducer's input shape; `undefined` for a kind this reducer doesn't cover (e.g. `config_option_update`, handled separately) or a malformed payload. Exported for direct unit testing of the wire-mapping logic (issue #248) without spinning up a fixture process for every edge case; not part of the package's public `index.ts`/`browser.ts` surface. */
export function mapToTranscriptUpdate(
  kind: string,
  sessionId: string,
  update: RawSessionUpdate,
  turnId: string,
): AcpTranscriptUpdate | undefined {
  switch (kind) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      if (!update.messageId) return undefined;
      const content = update.content as { type?: string; text?: string } | undefined;
      const text = content?.type === 'text' ? (content.text ?? '') : '';
      return { kind, turnId, messageId: update.messageId, text };
    }
    case 'tool_call':
    case 'tool_call_update': {
      if (!update.toolCallId) return undefined;
      return {
        kind,
        id: update.toolCallId,
        turnId,
        title: update.title,
        toolKind: update.kind,
        status: update.status,
        diff: extractDiff(update.content),
        rawInput: update.rawInput,
        content: update.content,
        parentToolCallId: update.parentToolCallId,
        locations: update.locations,
      };
    }
    // ACP's real wire discriminant for a plan report is `'plan'`, not
    // `'plan_update'` (agentclientprotocol.com/protocol/v1/agent-plan).
    // This client's OWN `AcpPlanUpdate.kind` is `'plan_update'` (chosen to
    // read as a verb alongside `tool_call_update`/`usage_update`), but the
    // wire never sends that string — the case label here has to match
    // ACP, not our internal name (issue #623: untested until now, since no
    // fixture or hand-written payload ever sent a real plan notification,
    // so every real agent's plan report was silently dropped by the
    // `default` branch below).
    case 'plan':
      return { kind: 'plan_update', entries: update.entries ?? [] };
    case 'usage_update':
      // `update.cost`'s `currency` is ISO 4217 and can legitimately be
      // anything an agent bills in; this client has no currency-conversion
      // logic anywhere, so a non-USD report is left `undefined` rather than
      // silently mislabeled as dollars — the meter under-reports for that
      // provider instead of lying (a known, documented gap, not a bug to
      // paper over with a fake conversion rate).
      return {
        kind: 'usage_update',
        sessionId,
        tokensUsed: update.used,
        contextWindow: update.size,
        costUsd: update.cost?.currency === 'USD' ? update.cost.amount : undefined,
      };
    default:
      return undefined;
  }
}

/**
 * The generic ACP core client (SPEC.md §5.5, §10, §16). Performs the ACP
 * `initialize` handshake, opens/resumes/lists sessions, sends prompts, and
 * reduces incoming `session/update` notifications along two parallel paths:
 * the v0 subset (`agent_message_chunk`/`user_message_chunk` only, emitted as
 * the legacy `'update'` event every existing consumer — `@loombox/node`,
 * `@loombox/supervisor`, `apps/web` — already depends on, kept byte-for-byte
 * unchanged) and the fuller v1 surface (`'transcript_update'`, the
 * `session/request_permission` FIFO queue, config-option state, capability
 * flags), additive to it.
 *
 * Transport is JSON-RPC 2.0 over the child process's stdio as
 * newline-delimited JSON, per the real ACP baseline.
 */
export class AcpClient extends EventEmitter {
  private readonly child: AcpChildProcess;
  private readonly rl: Interface;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessions = new Map<string, SessionState>();

  private readonly registry: ProviderRegistry | undefined;
  private readonly providerId: string | undefined;

  private readonly permissionQueue = new PermissionQueue();
  private readonly pendingPermissionRpcIds = new Map<string, number>();
  private readonly configOptionStore = new ConfigOptionStore();
  private readonly availableCommandsStore = new AvailableCommandsStore();

  private lastAgentCapabilities: AcpAgentCapabilities | undefined;
  private lastConfigCatalog: AcpConfigOption[] = [];

  constructor(childOrConfig: AcpChildProcess | AcpSpawnConfig, options: AcpClientOptions = {}) {
    super();
    this.registry = options.registry;
    this.providerId = options.providerId;

    this.child = isSpawnConfig(childOrConfig)
      ? (spawn(childOrConfig.command, childOrConfig.args, {
          cwd: childOrConfig.cwd,
          env: childOrConfig.env ? { ...process.env, ...childOrConfig.env } : process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as AcpChildProcess)
      : childOrConfig;

    this.child.on('error', (err: Error) => this.emit('error', err));
    this.child.on('exit', (code: number | null) => this.emit('exit', code));

    this.rl = createInterface({ input: this.child.stdout, terminal: false });
    this.rl.on('line', (line: string) => this.handleLine(line));

    // A resolution on the permission queue (from any subscriber, including
    // a session-level Stop's optimistic cancelAll) is what actually replies
    // to the agent's still-pending `session/request_permission` call.
    this.permissionQueue.on('resolved', (result: PermissionResolveResult) => {
      if (result.status !== 'resolved') return;
      const rpcId = this.pendingPermissionRpcIds.get(result.requestId);
      if (rpcId === undefined) return;
      this.pendingPermissionRpcIds.delete(result.requestId);
      this.sendResponse(rpcId, { outcome: result.outcome });
    });
    this.permissionQueue.on('enqueued', (request: unknown) =>
      this.emit('permission_request', request),
    );
  }

  /** ACP `initialize`: protocol version + capability negotiation (SPEC.md §5.5). Caches `agentCapabilities`/`configOptions` for `getFeatureFlags()` and each new/resumed session's config-option seed; a real `initialize` never actually carries `configOptions` (issue #705 — `session/new` is where they arrive), so this is the fallback path, kept for an agent that does answer here. */
  async initialize(): Promise<AcpInitializeResult> {
    const result = await this.sendRequest<
      Omit<AcpInitializeResult, 'configOptions'> & RawConfigCatalog
    >('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { [SUBAGENT_TRANSCRIPT_CAPABILITY_KEY]: true },
      },
      clientInfo: { name: 'loombox', version: '0.0.0' },
    });
    this.lastAgentCapabilities = result.agentCapabilities;
    this.lastConfigCatalog = mapConfigOptions(result);
    return {
      protocolVersion: result.protocolVersion,
      agentCapabilities: result.agentCapabilities,
      agentInfo: result.agentInfo,
      authMethods: result.authMethods,
      configOptions: this.lastConfigCatalog,
    };
  }

  /**
   * ACP `session/new`: opens a session rooted at `cwd`, returns its
   * sessionId. `opts.mcpServers` (issue #190; SPEC.md §7.7) is the caller's
   * already-resolved, effective MCP server set for this session — validated
   * (see `McpServerSecretMissingError`) and passed through verbatim as
   * `session/new`'s own `mcpServers` field; defaults to `[]`, matching this
   * client's pre-#190 behavior for a caller that doesn't configure any.
   * Scoped entirely to this one call: two sessions on the same client may
   * carry different MCP server sets with no effect on each other, and
   * changing what a later session gets never touches a session already open.
   */
  async newSession(cwd: string, opts: NewSessionOptions = {}): Promise<string> {
    const mcpServers = opts.mcpServers ?? [];
    assertMcpServersResolved(mcpServers);

    const result = await this.sendRequest<{ sessionId: string } & RawConfigCatalog>('session/new', {
      cwd,
      mcpServers,
    });
    this.ensureSession(result.sessionId);
    // `session/new`'s own catalog is the source of truth (a real agent
    // seeds it here, not at `initialize` — issue #705); `initialize`'s
    // cached catalog is only the fallback for an agent that answers there
    // instead, never a merge of the two.
    const sessionCatalog = mapConfigOptions(result);
    this.configOptionStore.setAll(
      result.sessionId,
      sessionCatalog.length > 0 ? sessionCatalog : this.lastConfigCatalog,
      { unprompted: false },
    );
    return result.sessionId;
  }

  /**
   * ACP `session/resume`: reopens a previously-created session. The agent is
   * expected to stream that session's history back as ordinary
   * `session/update` notifications (the same wire mechanism a live turn
   * uses) before or while responding — so it runs through the exact same
   * reducer path as a live stream (SPEC.md §7.24: "The same reducer runs
   * identically for a live stream and for replayed history on reconnect").
   * Also (re-)seeds this session's config-option state from the cached
   * `initialize` catalog, just like `newSession` does.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<string> {
    const session = this.ensureSession(sessionId);
    session.currentTurnId = `resume:${++session.turnCounter}`;
    this.configOptionStore.setAll(sessionId, this.lastConfigCatalog, { unprompted: false });

    const result = await this.sendRequest<{ sessionId?: string }>('session/resume', {
      sessionId,
      cwd,
    });
    return result.sessionId ?? sessionId;
  }

  /** ACP `session/list`: every session this agent process still holds. */
  async listSessions(): Promise<AcpSessionSummary[]> {
    const result = await this.sendRequest<{ sessions?: AcpSessionSummary[] }>('session/list', {});
    return result.sessions ?? [];
  }

  /**
   * ACP `session/cancel`: a fire-and-forget notification (no response is
   * expected). Per SPEC.md §7.24's "Multi-request ordering", also
   * optimistically resolves every open `session/request_permission` for
   * this session as cancelled immediately, rather than waiting for the
   * agent's own follow-up.
   */
  cancel(sessionId: string): void {
    this.permissionQueue.cancelAll(sessionId);
    const notification = { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } };
    this.child.stdin.write(`${JSON.stringify(notification)}\n`);
  }

  /**
   * ACP `session/prompt`: sends a user turn and awaits its response. The
   * required `text` becomes the first `ContentBlock::Text`; `extraContent`
   * (SPEC.md §7.25 "Hand off to the agent"; issue #158) appends any further
   * blocks a caller already resolved for this turn — an inline base64
   * image, or a `resource_link` for the on-disk fallback — verbatim, after
   * it. Defaults to `[]` so every existing plain-text caller is unaffected.
   * Emits `'turn_end'` once the response (the turn's `StopReason`) arrives,
   * carrying the id of the last `agent_message_chunk` message seen during
   * this turn, if any.
   */
  async prompt(
    sessionId: string,
    text: string,
    extraContent: AcpPromptContentBlock[] = [],
  ): Promise<void> {
    const session = this.ensureSession(sessionId);
    session.currentTurnId = `turn:${++session.turnCounter}`;

    const result = await this.sendRequest<{ stopReason?: string }>('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }, ...extraContent],
    });
    this.emit('turn_end', {
      messageId: session.lastAgentMessageId,
      stopReason: result.stopReason,
    });
  }

  /** Maps this client's negotiated `initialize` capabilities onto the flat UI feature-flag surface (SPEC.md §5.5; issue #180). */
  getFeatureFlags(): AcpFeatureFlags {
    return deriveFeatureFlags(this.lastAgentCapabilities);
  }

  /** The `session/request_permission` FIFO queue state machine for every session this client has seen (SPEC.md §7.24; issue #178). */
  get permissions(): PermissionQueue {
    return this.permissionQueue;
  }

  /** Per-session config-option state (`model`/`mode`/`thought_level`/...; SPEC.md §7.24; issue #179). */
  get configOptions(): ConfigOptionStore {
    return this.configOptionStore;
  }

  /** Per-session available-command state — the `/`-command catalogue the connected agent declared via `available_commands_update` (SPEC.md §7.24; issue #741). */
  get availableCommands(): AvailableCommandsStore {
    return this.availableCommandsStore;
  }

  /**
   * Sends a user-driven config-option change (`session/set_config_option`)
   * and applies the agent's full, wholesale-replaced option list to
   * `configOptions` once it acks — never a per-category patch.
   *
   * The real wire request is `{sessionId, configId, value, type}` (issue
   * #707), not `{category, choiceId}` (a real agent 400s that with
   * "Invalid params" — verified against the real `omp acp` binary). This
   * method's own public parameter stays `category`, matching every
   * existing caller and what `ConfigOptionStore` groups on, but `configId`
   * and `type` are NOT the same thing as `category` and a caller cannot be
   * asked to invent them: `configId` is the wire entry's own `id` (its
   * `thinking` option has `id: "thinking"` but `category: "thought_level"`
   * — sending `category` as `configId` is rejected outright, "Unknown ACP
   * config option: thought_level"), and `type` is that entry's own
   * `'select' | 'boolean'`. Both are sourced from the catalogue entry
   * already seeded for this category — `mapConfigOptions` retains
   * `AcpConfigOption.id`/`.type` for exactly this reason, a field this
   * store used to drop. A category this session's catalogue has no entry
   * for throws before any request is sent, rather than guessing; a
   * category the catalogue *does* carry — however unrecognized/future its
   * name — works unmodified (issue #179's passthrough guarantee: nothing
   * here branches on a specific category value).
   *
   * The response's real field is `configOptions` (wire-shaped), not
   * `options` (this client's internal shape) — the same class of bug
   * #705 fixed for `session/new`/`config_option_update`; reuses that same
   * `mapConfigOptions` rather than a second translation.
   *
   * Rejects (never swallows) if the agent rejects the change — e.g. an
   * unsupported value — exactly like any other `sendRequest` failure, so a
   * caller that awaits this finds out. No caller in this codebase invokes
   * this method yet (see the PR this shipped in for the seam that leaves
   * open, going into #711's consolidated control).
   */
  async setConfigOption(
    sessionId: string,
    category: string,
    choiceId: string,
  ): Promise<AcpConfigOption[]> {
    const current = this.configOptionStore
      .get(sessionId)
      .find((option) => option.category === category);
    if (!current?.id || !current.type) {
      throw new Error(
        `AcpClient.setConfigOption: no catalogue entry for category "${category}" on session "${sessionId}" carries a configId/type to build a real session/set_config_option request from — the agent must advertise this category (via session/new's configOptions) before a caller can act on it.`,
      );
    }
    const result = await this.sendRequest<RawConfigCatalog>('session/set_config_option', {
      sessionId,
      configId: current.id,
      value: choiceId,
      type: current.type,
    });
    this.configOptionStore.setAll(sessionId, mapConfigOptions(result), { unprompted: false });
    return this.configOptionStore.get(sessionId);
  }

  /** This session's current v1 transcript state (SPEC.md §7.24's reducer output); `createTranscriptState()`'s empty shape if the session is unknown. */
  getTranscriptState(sessionId: string): TranscriptState {
    return this.sessions.get(sessionId)?.transcriptState ?? createTranscriptState();
  }

  /** Every enriched `AcpTranscriptUpdate` seen for a session so far, oldest first. */
  getHistory(sessionId: string): AcpTranscriptUpdate[] {
    return [...(this.sessions.get(sessionId)?.history ?? [])];
  }

  /**
   * Re-emits this session's buffered `AcpTranscriptUpdate` history as
   * `'transcript_update'` events, in original order, without re-reducing or
   * re-storing anything — so a consumer that attaches its listener late
   * (e.g. a UI component mounting after the session already has history)
   * can call this once to catch up (SPEC.md §5.5's "session/resume +
   * replay"; issue #176).
   */
  replay(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const update of session.history) {
      this.emit('transcript_update', { sessionId, update, state: session.transcriptState });
    }
  }

  /** Terminates the underlying agent process and stops reading its output. */
  close(): void {
    this.rl.close();
    this.child.kill();
  }

  private ensureSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        buffers: new Map(),
        lastAgentMessageId: undefined,
        transcriptState: createTranscriptState(),
        history: [],
        currentTurnId: 'turn:0',
        turnCounter: 0,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private sendRequest<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const request: JsonRpcRequestOut = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  private sendResponse(id: number, result: unknown): void {
    const response: JsonRpcSuccess = { jsonrpc: '2.0', id, result };
    this.child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcInbound;
    try {
      msg = JSON.parse(trimmed) as JsonRpcInbound;
    } catch (err) {
      this.emit('error', new Error(`AcpClient: failed to parse line as JSON: ${String(err)}`));
      return;
    }

    if (isSuccessOrFailure(msg)) {
      this.handleResponse(msg);
      return;
    }
    if (isNotification(msg)) {
      this.handleNotification(msg);
      return;
    }
    if (isIncomingRequest(msg)) {
      this.handleIncomingRequest(msg);
      return;
    }
  }

  private handleResponse(msg: JsonRpcSuccess | JsonRpcFailure): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if ('error' in msg) {
      // A real agent's rejection carries the actionable reason in
      // `error.data.details` (verified against the real `omp acp` binary
      // — e.g. `session/set_config_option`'s "Unknown ACP config option: X"
      // / "Unsupported ACP mode: Y" both arrive this way, not in
      // `error.message`, which is just the generic JSON-RPC class of error
      // like "Internal error"), so a caller that only reads `.message`
      // on a rejected promise still finds out *why* rather than just
      // *that* it failed (issue #707's "make the outcome honest").
      const details = extractErrorDetails(msg.error.data);
      pending.reject(
        new Error(
          `AcpClient: ${msg.error.message} (code ${msg.error.code})${details ? `: ${details}` : ''}`,
        ),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * An agent -> client request. `session/request_permission` (SPEC.md
   * §7.24, §5.5; issue #178) is the only one this v1 client answers: it
   * enqueues onto the FIFO permission queue and replies once a subscriber
   * resolves it (see the `permissionQueue.on('resolved', ...)` wiring in
   * the constructor). Anything else (e.g. `fs/*`) stays out of scope and is
   * ignored, same as v0 — never respond incorrectly to a method this client
   * doesn't actually implement.
   */
  private handleIncomingRequest(msg: JsonRpcRequestIn): void {
    if (msg.method !== 'session/request_permission') return;

    const params = msg.params as RequestPermissionParamsWire | undefined;
    if (!params?.sessionId || !params.toolCall?.toolCallId) return;

    const requestId = `perm:${msg.id}`;
    this.pendingPermissionRpcIds.set(requestId, msg.id);
    this.permissionQueue.enqueue({
      requestId,
      sessionId: params.sessionId,
      toolCall: {
        kind: 'tool_call',
        id: params.toolCall.toolCallId,
        title: params.toolCall.title,
        toolKind: params.toolCall.kind,
        status: params.toolCall.status,
        diff: extractDiff(params.toolCall.content),
        rawInput: params.toolCall.rawInput,
        content: params.toolCall.content,
        parentToolCallId: params.toolCall.parentToolCallId,
        locations: params.toolCall.locations,
      },
      options: params.options ?? [],
    });
  }

  private handleNotification(msg: JsonRpcNotificationIn): void {
    if (msg.method !== 'session/update') return;

    const params = msg.params as SessionUpdateParams | undefined;
    const update = params?.update;
    const kind = update?.sessionUpdate;
    const sessionId = params?.sessionId;
    if (!kind || !sessionId || !update) return;

    // config_option_update is agent-pushed, unprompted config state (SPEC.md
    // §7.24; issue #179), wire-mapped the same way `initialize`/
    // `session/new` are (issue #705) — it never touches the transcript
    // reducer.
    if (kind === 'config_option_update') {
      this.configOptionStore.setAll(
        sessionId,
        mapConfigOptions({ configOptions: update.configOptions }),
        { unprompted: true },
      );
      return;
    }

    // available_commands_update (issue #741): same "agent-pushed, wire-mapped,
    // never touches the transcript reducer" shape as config_option_update
    // just above — there is no separate "seeded at session/new" variant to
    // distinguish here (unlike config options), since a real agent only ever
    // sends this notification, never as part of `session/new`'s own result
    // (verified directly against a real `omp acp` binary).
    if (kind === 'available_commands_update') {
      this.availableCommandsStore.setAll(sessionId, mapAvailableCommands(update.availableCommands));
      return;
    }

    const session = this.ensureSession(sessionId);

    // v0 subset, unchanged: agent_message_chunk / user_message_chunk append
    // into `session.buffers` and emit the legacy 'update' event every
    // existing consumer already depends on.
    if (kind === 'agent_message_chunk' || kind === 'user_message_chunk') {
      const messageId = update.messageId;
      if (messageId) {
        const content = update.content as { type?: string; text?: string } | undefined;
        const text = content?.type === 'text' ? (content.text ?? '') : '';
        const bufferKey = `${kind}:${messageId}`;
        const appended = (session.buffers.get(bufferKey) ?? '') + text;
        session.buffers.set(bufferKey, appended);
        if (kind === 'agent_message_chunk') session.lastAgentMessageId = messageId;

        const outUpdate: AcpUpdate = { kind: kind as AcpUpdateKind, messageId, text: appended };
        this.emit('update', outUpdate);
      }
    }

    // v1: fold every reducer-understood kind into this session's running
    // TranscriptState, additive to the v0 path above (SPEC.md §7.24).
    const transcriptUpdate = mapToTranscriptUpdate(kind, sessionId, update, session.currentTurnId);
    if (!transcriptUpdate) return;

    const enriched =
      this.registry && this.providerId
        ? this.registry.enrich(this.providerId, transcriptUpdate, update)
        : transcriptUpdate;

    session.history.push(enriched);
    session.transcriptState = reduceTranscript(session.transcriptState, enriched);
    this.emit('transcript_update', { sessionId, update: enriched, state: session.transcriptState });
  }
}
