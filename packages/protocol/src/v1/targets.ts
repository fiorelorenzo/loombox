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
  /**
   * The provider ids this target can ACTUALLY spawn an agent for (SPEC §5.5),
   * so a session-creation UI never offers an agent that would fail at spawn
   * time. Availability is per TARGET, not per node: an `ssh:` target runs the
   * agent on the remote host, so what matters is the CLI on THAT machine's
   * PATH, not the node's. The node probes each registered provider module's
   * `requiredCommand` (the vendor CLI its bridge drives - `claude`, `codex`,
   * `omp` - never `npx`) against the target's own PATH and lists what
   * answered.
   *
   * An empty array is a legitimate, meaningful value: a reachable target with
   * no agent CLI installed. Clients must render that as "nothing to run here"
   * rather than falling back to a hardcoded guess, which is exactly the lie
   * this field exists to remove - the web's picker used to offer a single
   * hardcoded `claude` on every target, including ones without it installed.
   */
  providers: z.array(z.string().min(1)),
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
 * host is, never anything about what's running on it (a hostname is not a
 * secret that boundary hides either — see `provisioning.ts`'s doc comment).
 *
 * `cpuPercent` is a **misnomer kept only for wire back-compat**: every
 * sampler has always computed it from load average (a run-queue-length
 * proxy: runnable *and* uninterruptible-sleep tasks), never true CPU
 * utilization — a host can read 100% here while its cores sit mostly idle.
 * `loadPercent` is the identical figure under its honest name; new code
 * should read that one instead and label it "Load", not "CPU". Both
 * `loadPercent` and the identification fields below (`hostname`/
 * `platform`/`arch`) are **optional additions**: a node that predates them
 * never sends them, and this schema still parses its `cpuPercent`-only
 * payload; a node running this schema always sends all of them.
 */
export const targetHealth = z.object({
  /** @deprecated Load-average-derived, not CPU utilization — see this schema's own doc comment. Kept for back-compat; read `loadPercent` instead. */
  cpuPercent: z.number().min(0).max(100),
  /** The honestly-named replacement for the deprecated `cpuPercent` above (identical value): 1-minute load average normalized by core count. Optional only because an older node has never sent it. */
  loadPercent: z.number().min(0).max(100).optional(),
  memPercent: z.number().min(0).max(100),
  memUsedBytes: z.number().nonnegative(),
  memTotalBytes: z.number().nonnegative(),
  diskPercent: z.number().min(0).max(100),
  diskUsedBytes: z.number().nonnegative(),
  diskTotalBytes: z.number().nonnegative(),
  healthy: z.boolean(),
  /** Milliseconds since epoch, when this sample was taken (the node's clock). */
  sampledAt: z.number(),
  /** This target's machine hostname — lets a UI tell apart two targets sharing a generic label like "Local". Optional: an older node has never sent it. */
  hostname: z.string().min(1).optional(),
  /** `'linux'`/`'darwin'`/... (`os.platform()`'s vocabulary, including over `ssh:`). Optional: an older node has never sent it. */
  platform: z.string().min(1).optional(),
  /** `'x64'`/`'arm64'`/... (`os.arch()`'s vocabulary, including over `ssh:`). Optional: an older node has never sent it. */
  arch: z.string().min(1).optional(),
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
  /** {@link targetDescriptor.providers} forwarded verbatim: what this target can actually spawn. The relay never invents or filters this - it is the node's own probe result, and a client picker reads it directly. */
  providers: z.array(z.string().min(1)),
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
