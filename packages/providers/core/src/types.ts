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

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: AcpAgentInfo;
  authMethods?: unknown[];
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

/** The generic-fallback tool-call category (SPEC.md §7.24's tier-2 `ToolKind`-driven row). */
export type AcpToolKind =
  'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

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
