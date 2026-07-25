import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/**
 * Connection management's wire pair (redesign v2 §3.3; issue #476):
 * `TargetStatusView`'s Reconnect/Update/Remove/Edit actions. The node-side
 * logic already exists and is tested — `packages/node/src/ssh/
 * decommission.ts`'s `decommissionSshTarget` (issue #90) and
 * `packages/node/src/ssh/target-update-monitor.ts`'s `TargetUpdateMonitor`
 * (issue #88) — this module is only the two additive request/response pairs
 * that expose them over the relay, mirroring `provisioning.ts`'s own
 * "routing metadata only" boundary: a decommission outcome (which systemd
 * steps ran, whether files were removed) and an update outcome (an
 * old/new version string) are no more sensitive than `provisionTargetResult`'s
 * own step-outcome fields, so neither pair carries an `encryptedEnvelope`.
 *
 * Both are addressed directly by `nodeId` + `targetId` — the target already
 * exists (unlike `provision_target_request`'s brand-new one), so this is
 * closer to `target_fs_list_request`'s own "no session to resolve through,
 * address the node+target directly" convention. There is no Reconnect wire
 * message: a stalled `ssh:` target's transport already auto-reconnects on
 * next use (`SshTransportPool`), so "Reconnect" in the UI is just asking the
 * relay for a fresh `target_list`/`target_status` read, not a new mechanism.
 *
 * Removing files (`removeFiles`) defaults to `false` on the wire, exactly
 * like `DecommissionOptions.removeFiles`'s own default — stopping/disabling
 * any unit and revoking the target from the node's trusted set always
 * happen; file cleanup stays an explicit opt-in the client must ask for.
 */

/** A client asks `nodeId` to decommission one of its existing targets (Remove, or the teardown half of Edit). */
export const decommissionTargetRequest = z.object({
  type: z.literal('decommission_target_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  /** Also removes the staged supervisor directory + unit file from the remote; defaults to `false` (mirrors `DecommissionOptions.removeFiles`). */
  removeFiles: z.boolean().optional(),
});
export type DecommissionTargetRequest = z.infer<typeof decommissionTargetRequest>;

/** The successful outcome's step summary — mirrors `DecommissionResult` field-for-field, minus `ranCommands` (internal debug detail the UI has no use for). */
export const decommissionResultV1 = z.object({
  unitWasInstalled: z.boolean(),
  unitStopped: z.boolean(),
  unitDisabled: z.boolean(),
  deviceKeyRevoked: z.boolean(),
  filesRemoved: z.boolean(),
});
export type DecommissionResultV1 = z.infer<typeof decommissionResultV1>;

/**
 * The acting node's reply, delivered back to the requesting client only —
 * the relay matches it to its pending `decommission_target_request` by
 * `requestId`, exactly like `target_fs_list_response`. `ok: false` covers
 * both an unknown/foreign target and a genuine decommission failure (an
 * unreachable transport, a failed remote command); `result` is only ever
 * set alongside `ok: true`, `message` is always a human-readable summary.
 */
export const decommissionTargetResponse = z.object({
  type: z.literal('decommission_target_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  ok: z.boolean(),
  result: decommissionResultV1.optional(),
  message: z.string().min(1),
});
export type DecommissionTargetResponse = z.infer<typeof decommissionTargetResponse>;

/** A client asks `nodeId` to run the "Update" one-tap action against one of its targets (`TargetUpdateMonitor.updateTarget`). */
export const targetUpdateRequest = z.object({
  type: z.literal('target_update_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
});
export type TargetUpdateRequest = z.infer<typeof targetUpdateRequest>;

/** Mirrors `TargetUpdateMonitor`'s own `TargetVersionStatus` field-for-field. */
export const targetVersionStatusV1 = z.enum(['current', 'behind', 'ahead', 'unknown']);
export type TargetVersionStatusV1 = z.infer<typeof targetVersionStatusV1>;

/**
 * The acting node's reply, delivered back to the requesting client only —
 * matched by `requestId`, exactly like `decommission_target_response`.
 * `status`/`remoteVersion` come from the monitor's post-update re-handshake
 * (`TargetUpdateMonitor.updateTarget`'s own "immediately re-handshakes"
 * contract); `installedVersion` is only set once `ok`. `ok: false` covers an
 * unknown/foreign target, a node with no update mechanism configured, and a
 * genuine provisioning failure alike — `message` always explains which.
 */
export const targetUpdateResponse = z.object({
  type: z.literal('target_update_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  ok: z.boolean(),
  status: targetVersionStatusV1.optional(),
  remoteVersion: z.string().optional(),
  installedVersion: z.string().optional(),
  message: z.string().min(1),
});
export type TargetUpdateResponse = z.infer<typeof targetUpdateResponse>;
