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
