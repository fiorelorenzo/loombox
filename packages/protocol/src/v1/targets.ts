import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/** The two execution-target kinds v1 supports (SPEC §5.2): run on the node's own machine, or over SSH. */
export const targetKind = z.enum(['local', 'ssh']);
export type TargetKind = z.infer<typeof targetKind>;

/** One execution target a node exposes, so clients can start a session anywhere the node can reach. */
export const targetDescriptor = z.object({
  id: z.string().min(1),
  kind: targetKind,
  label: z.string().min(1),
});
export type TargetDescriptor = z.infer<typeof targetDescriptor>;

/** A node publishes the full set of targets it currently exposes (SPEC §5.2). */
export const targetAnnounce = z.object({
  type: z.literal('target_announce'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  targets: z.array(targetDescriptor),
});
export type TargetAnnounce = z.infer<typeof targetAnnounce>;

/**
 * A client asks the relay which nodes/targets exist for its account (issue
 * #383), so a session-creation UI has something to populate — the
 * client-facing counterpart of `target_announce` above, which is node-to-relay
 * only. Additive: an older relay that doesn't recognize `target_list_request`
 * simply never replies, no different from any other unsupported message.
 */
export const targetListRequest = z.object({
  type: z.literal('target_list_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
});
export type TargetListRequest = z.infer<typeof targetListRequest>;

/**
 * One target in a `target_list` response: `TargetDescriptor`'s routing
 * metadata (id/kind/label) plus which node owns it and whether that node is
 * currently reachable (has a live relay connection) — still metadata only,
 * per SPEC §8's boundary; never a path, credential, or anything else a node
 * might otherwise expose about a target.
 */
export const targetListEntry = z.object({
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  label: z.string().min(1),
  kind: targetKind,
  reachable: z.boolean(),
});
export type TargetListEntry = z.infer<typeof targetListEntry>;

/** The relay's account-scoped reply to `target_list_request`: every target announced by a node this account owns. */
export const targetList = z.object({
  type: z.literal('target_list'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  targets: z.array(targetListEntry),
});
export type TargetList = z.infer<typeof targetList>;
