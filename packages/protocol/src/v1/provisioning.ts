import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/**
 * Zero-touch add-target provisioning (SPEC §7.23; issue #408): a client asks
 * the account's already-connected node to provision + pair a brand-new
 * `ssh:` target end-to-end — `packages/node/src/ssh/provision-target.ts`'s
 * `provision()` (issue #400), the authenticated node-token mint
 * (`POST /account/node-tokens`, issue #401), and the AMK handoff
 * (`writeWrappedAmkHandoff`, issue #399) — behind ONE in-app confirmation
 * the wizard shows before ever sending {@link ProvisionTargetRequest}. There
 * is no RFC 8628 `user_code` step here (Lorenzo's decision): the human
 * checkpoint is the wizard's own explicit "Continue?" confirmation, not a
 * second device's approval.
 *
 * Routing metadata only, exactly like `sessions.ts`/`targets.ts`'s own
 * boundary: a hostname/username is not a secret SPEC §8 asks to hide (that
 * line is passwords/private keys/the AMK itself) — none of those three ever
 * appear below. The actual AMK handoff happens node<->target over its own
 * already-encrypted SSH channel, never through the relay (mirrors
 * `amk-handoff-provision.ts`'s own doc comment).
 *
 * **Relay wiring is a follow-up, out of this issue's scope.** This wave
 * spans `packages/protocol` + `packages/node` + `apps/web` only —
 * `packages/relay/src/relay.ts`'s `handleClientMessage`/`handleNodeMessage`
 * switches need a case addressed directly by `nodeId` (there is no existing
 * target yet to resolve a routing lookup through, unlike `session_create`'s
 * `targetId`->node lookup) plus a way to route `provision_progress`/
 * `provision_target_result` back to the requesting client. Until that
 * relay-side case exists, an older/unmodified relay simply never forwards
 * these three message types — the same "additive, ignored by anything that
 * doesn't recognize it" negotiation-safety every other v1 message type
 * already has.
 */

/**
 * The host the client picked or typed in the wizard's first step. `alias`
 * matches an autodetected `~/.ssh/config` entry on the acting node
 * (`packages/node/src/ssh/host-candidates.ts`'s `SshHostCandidate.alias`),
 * letting the node reuse that entry's own user/port/identityFiles rather
 * than needing them repeated here; omit it for a fully manual host (SPEC
 * §7.23's "falls back to manual entry when nothing is discoverable").
 */
export const provisionTargetHostInputV1 = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  user: z.string().min(1).optional(),
  alias: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
});
export type ProvisionTargetHostInputV1 = z.infer<typeof provisionTargetHostInputV1>;

/**
 * One step of the acting node's provision-and-pair sequence: composes
 * `provision-target.ts`'s own three pre-pairing steps (`verify_and_persist`,
 * `runtime_bootstrap`, `supervisor_install` — its fourth step,
 * `resident_node_install`, is deliberately re-run standalone AFTER pairing
 * below, not inline, since it needs the minted token/handoff path first)
 * with the three zero-touch pairing steps this issue adds:
 * `target_identity` (generating + writing the new resident's own device
 * identity to the remote ahead of its first start), `mint_node_token`
 * (`POST /account/node-tokens`), and `amk_handoff`
 * (`writeWrappedAmkHandoff`) — then finally `resident_node_install` itself.
 */
export const provisionStepIdV1 = z.enum([
  'verify_and_persist',
  'runtime_bootstrap',
  'supervisor_install',
  'target_identity',
  'mint_node_token',
  'amk_handoff',
  'resident_node_install',
]);
export type ProvisionStepIdV1 = z.infer<typeof provisionStepIdV1>;

/** A step's lifecycle: `started` right before it runs, then exactly one of `ok`/`failed` once it settles. */
export const provisionStepStatusV1 = z.enum(['started', 'ok', 'failed']);
export type ProvisionStepStatusV1 = z.infer<typeof provisionStepStatusV1>;

/**
 * A client asks a specific node (already known to own this account, e.g.
 * from `target_list`'s `nodeId` — SPEC §7.23's "the account's existing
 * node") to provision-and-pair a brand-new `ssh:` target. `targetId` is
 * client-generated: the id the new target is announced under once pairing
 * succeeds (mirrors `sessionCreate`'s own client-generated `sessionId`).
 */
export const provisionTargetRequest = z.object({
  type: z.literal('provision_target_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  host: provisionTargetHostInputV1,
});
export type ProvisionTargetRequest = z.infer<typeof provisionTargetRequest>;

/**
 * The acting node's own progress update for one step, streamed as the
 * sequence runs — the wizard's live-progress screen renders these directly.
 * A requesting client matches its own pending request by `requestId`,
 * exactly like `fs_list_response`/`terminal_opened`'s own convention.
 */
export const provisionProgress = z.object({
  type: z.literal('provision_progress'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  step: provisionStepIdV1,
  status: provisionStepStatusV1,
  message: z.string().min(1),
});
export type ProvisionProgress = z.infer<typeof provisionProgress>;

/** The sequence's final outcome — success (the new target is now paired and usable) or the step it stopped at. */
export const provisionTargetResult = z.object({
  type: z.literal('provision_target_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  ok: z.boolean(),
  failedStep: provisionStepIdV1.optional(),
  message: z.string().min(1),
});
export type ProvisionTargetResult = z.infer<typeof provisionTargetResult>;
