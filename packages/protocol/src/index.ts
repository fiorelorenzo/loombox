import { z } from 'zod';
import { schemasV1 } from './v1/index';

/**
 * The wire-protocol version, negotiated once per connection following ACP's
 * `initialize` handshake pattern (SPEC §10, §16). Bump on any
 * backwards-incompatible change to the schemas below.
 *
 * This is v0. **v1 lives alongside it, additively, in `./v1/` (re-exported
 * below)** — every export in this file stays untouched; v1 introduces its
 * own `PROTOCOL_V1`, its own message families, and its own `wireMessageV1`
 * union rather than extending this one, per the migration plan in
 * `docs/v1-plan.md` (v0 is disposable and removed once downstream migrates).
 */
export const PROTOCOL_VERSION = 0;

/** Fields every wire message carries so the receiver can gate on version. */
export const baseMessage = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type BaseMessage = z.infer<typeof baseMessage>;

/**
 * Metadata a node announces to the relay (and the relay snapshots back to
 * clients) about a running agent session. v0 only ever has a `local`
 * execution target; `ssh:` targets land in v1 (SPEC §12).
 */
export const sessionMeta = z.object({
  id: z.string(),
  nodeId: z.string(),
  projectPath: z.string(),
  worktreePath: z.string(),
  target: z.literal('local'),
  provider: z.string(),
  title: z.string().optional(),
  createdAt: z.number(),
});
export type SessionMeta = z.infer<typeof sessionMeta>;

/**
 * An incremental update to a session's transcript, wrapping the subset of
 * ACP `session/update` notifications v0 needs to render a live view
 * (SPEC §10, §16).
 */
export const sessionUpdate = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent_message_chunk'),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('user_message_chunk'),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('agent_turn_end'),
    messageId: z.string(),
  }),
  z.object({
    kind: z.literal('error'),
    message: z.string(),
  }),
]);
export type SessionUpdate = z.infer<typeof sessionUpdate>;

/** A node registers with the relay. */
export const nodeHello = z.object({
  type: z.literal('node_hello'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  nodeId: z.string(),
  nodeName: z.string().optional(),
});
export type NodeHello = z.infer<typeof nodeHello>;

/** A PWA client registers with the relay. */
export const clientHello = z.object({
  type: z.literal('client_hello'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  clientId: z.string(),
});
export type ClientHello = z.infer<typeof clientHello>;

/** A node tells the relay a session exists. */
export const sessionAnnounce = z.object({
  type: z.literal('session_announce'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  session: sessionMeta,
});
export type SessionAnnounce = z.infer<typeof sessionAnnounce>;

/** The relay's snapshot of known sessions, sent to a connecting client. */
export const sessionList = z.object({
  type: z.literal('session_list'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessions: z.array(sessionMeta),
});
export type SessionList = z.infer<typeof sessionList>;

/** Wraps a SessionUpdate for fan-out, tagged with the session it belongs to. */
export const sessionUpdateEnvelope = z.object({
  type: z.literal('session_update'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: z.string(),
  update: sessionUpdate,
});
export type SessionUpdateEnvelope = z.infer<typeof sessionUpdateEnvelope>;

/** A client asks the relay to forward a follow-up prompt to a session. */
export const promptInject = z.object({
  type: z.literal('prompt_inject'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: z.string(),
  promptId: z.string(),
  text: z.string(),
});
export type PromptInject = z.infer<typeof promptInject>;

/** The full v0 wire message set, discriminated on `type`. */
export const wireMessage = z.discriminatedUnion('type', [
  nodeHello,
  clientHello,
  sessionAnnounce,
  sessionList,
  sessionUpdateEnvelope,
  promptInject,
]);
export type WireMessage = z.infer<typeof wireMessage>;

/** Parses and validates an inbound wire payload, throwing on an invalid one. */
export function parseWireMessage(data: unknown): WireMessage {
  return wireMessage.parse(data);
}

/** Same as {@link parseWireMessage} but never throws; returns zod's result. */
export function safeParseWireMessage(data: unknown): z.SafeParseReturnType<unknown, WireMessage> {
  return wireMessage.safeParse(data);
}

/** Registry of the v0 wire schemas, for introspection/tooling. */
const schemasV0 = {
  baseMessage,
  sessionMeta,
  sessionUpdate,
  nodeHello,
  clientHello,
  sessionAnnounce,
  sessionList,
  sessionUpdateEnvelope,
  promptInject,
  wireMessage,
} as const;

/**
 * Registry of every wire schema, v0 and v1 together, for introspection/
 * tooling. Additive: v0's shape here is unchanged, v1's schemas are merged
 * in under their own names (see `./v1/index.ts`'s `schemasV1`).
 */
export const schemas = {
  ...schemasV0,
  ...schemasV1,
} as const;

// Re-export the full v1 wire contract (SPEC §10, §16; `docs/v1-plan.md`;
// issue #315) alongside the v0 schema above. See the module docstring in
// `./v1/index.ts` for the message-family list.
export * from './v1/index';
