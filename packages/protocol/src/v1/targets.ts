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
