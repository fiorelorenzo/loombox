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
 * One target's resource/health reading (SPEC §7.16's "resource awareness
 * (CPU/RAM/disk per target)" and §7.21's status view; issues #253/#269).
 * `healthy` is `false` only when the sample itself couldn't be taken (a
 * failed `ssh:` exec, an unreadable disk path) — the proxy for #269's
 * "agent-process health", since a target this node can no longer run a
 * command against can't be running agents in any state worth calling
 * healthy. A successful sample with high CPU/RAM is still `healthy: true`;
 * that's overload, a distinct cause from a crashed/unreachable target (see
 * `TargetListEntry.health`'s doc comment). All percentages are clamped to
 * `[0, 100]` by the sampler even though CPU load can nominally exceed 100%
 * on an overloaded multi-core host — this is a display figure, not a raw
 * ratio. Still routing metadata only, per SPEC §8's boundary: how loaded a
 * host is, never anything about what's running on it.
 */
export const targetHealth = z.object({
  cpuPercent: z.number().min(0).max(100),
  memPercent: z.number().min(0).max(100),
  memUsedBytes: z.number().nonnegative(),
  memTotalBytes: z.number().nonnegative(),
  diskPercent: z.number().min(0).max(100),
  diskUsedBytes: z.number().nonnegative(),
  diskTotalBytes: z.number().nonnegative(),
  healthy: z.boolean(),
  /** Milliseconds since epoch, when this sample was taken (the node's clock). */
  sampledAt: z.number(),
});
export type TargetHealth = z.infer<typeof targetHealth>;

/** One target's {@link targetHealth} reading, tagged with which target it belongs to — the shape `target_status`'s `samples` array carries. */
export const targetResourceSample = targetHealth.extend({
  targetId: z.string().min(1),
});
export type TargetResourceSample = z.infer<typeof targetResourceSample>;

/**
 * A node pushes its latest per-target resource samples on a bounded
 * interval (issue #253's sampler, feeding #269's status view) — additive
 * and independent of `target_announce`'s rarer id/kind/label churn, so a
 * live CPU/RAM/disk refresh never has to re-send full target identity. An
 * older relay that doesn't recognize `target_status` simply drops it, the
 * same forward-compat story `target_list_request` documents above. The
 * relay only records a sample for a `targetId` this `nodeId` has actually
 * announced (never trusting a stray claim) — see `TargetStore.updateHealth`.
 */
export const targetStatus = z.object({
  type: z.literal('target_status'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  samples: z.array(targetResourceSample),
});
export type TargetStatus = z.infer<typeof targetStatus>;

/**
 * One target in a `target_list` response: `TargetDescriptor`'s routing
 * metadata (id/kind/label) plus which node owns it and whether that node is
 * currently reachable (has a live relay connection) — still metadata only,
 * per SPEC §8's boundary; never a path, credential, or anything else a node
 * might otherwise expose about a target. `health` is the relay's latest
 * received `target_status` sample for this target, if any has arrived yet
 * (issue #269) — absent for a target that has never sent one (a node that
 * predates this feature, or hasn't completed its first sample tick).
 */
export const targetListEntry = z.object({
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  label: z.string().min(1),
  kind: targetKind,
  reachable: z.boolean(),
  health: targetHealth.optional(),
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
