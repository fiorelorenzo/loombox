import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/**
 * The add-target wizard's "ask a paired node to discover ITS OWN SSH hosts"
 * wire pair (redesign v2 §3.2; issue #475). `packages/node/src/ssh/
 * host-candidates.ts`'s `discoverSshTargets()` already implements the real
 * work (parsing `~/.ssh/config`, detecting ssh-agent) and is exported from
 * `@loombox/node`'s public `index.ts` — the desktop app's IPC bridge calls it
 * directly for the desktop-MACHINE case (`apps/desktop/src/main/
 * ssh-candidates.ts`), but a PWA client has no local filesystem/IPC access
 * of its own, so it needs the account's already-connected node to run
 * discovery on ITS OWN machine and report the candidates back over the
 * relay. This pair is that round trip: nodeId-scoped (there is no target
 * yet — the whole point is choosing one), exactly like
 * `provisioning.ts`'s `provisionTargetRequest`, not `target-fs.ts`'s
 * nodeId+targetId.
 *
 * Crypto boundary: plain fields, no `encryptedEnvelope`. An autodetected
 * `~/.ssh/config` alias/hostname/username/identity-file PATH is exactly the
 * same kind of metadata `provisioning.ts`'s `provisionTargetHostInputV1`
 * already sends in the clear — SPEC §8's boundary is passwords/private
 * keys/the AMK itself (see that module's doc comment), never a hostname or
 * a path, and nothing more sensitive than that crosses this pair either.
 * The relay only ever routes on `nodeId`/`requestId`; it never needs to
 * understand the candidates themselves.
 */

/** One identity loaded into the acting node's own ssh-agent (mirrors `@loombox/node`'s `SshAgentIdentity`). */
export const sshAgentIdentityV1 = z.object({
  bits: z.number().int().nonnegative(),
  fingerprint: z.string().min(1),
  comment: z.string(),
  type: z.string().min(1),
});
export type SshAgentIdentityV1 = z.infer<typeof sshAgentIdentityV1>;

/** The acting node's own ssh-agent availability + loaded identities (mirrors `@loombox/node`'s `DetectSshAgentResult`) — a usable auth option once a host is picked, independent of which host. */
export const sshAgentInfoV1 = z.object({
  available: z.boolean(),
  socketPath: z.string().optional(),
  identities: z.array(sshAgentIdentityV1),
});
export type SshAgentInfoV1 = z.infer<typeof sshAgentInfoV1>;

/** One selectable candidate for the wizard's candidate-card picker (mirrors `@loombox/node`'s `SshHostCandidate` field-for-field). */
export const sshHostCandidateV1 = z.object({
  alias: z.string().min(1),
  hostName: z.string().min(1),
  user: z.string().optional(),
  port: z.number().int().positive().optional(),
  identityFiles: z.array(z.string()),
});
export type SshHostCandidateV1 = z.infer<typeof sshHostCandidateV1>;

/** The acting node's discovery ran cleanly (mirrors `@loombox/node`'s `SshTargetDiscovery`) — `requiresManualEntry` is the wizard's cue to skip straight to its "enter manually" fallback. */
export const sshDiscoveryResultOkV1 = z.object({
  outcome: z.literal('ok'),
  candidates: z.array(sshHostCandidateV1),
  agent: sshAgentInfoV1,
  requiresManualEntry: z.boolean(),
});
export type SshDiscoveryResultOkV1 = z.infer<typeof sshDiscoveryResultOkV1>;

/**
 * Discovery itself never throws (`discoverSshTargets`'s own contract), but
 * this variant exists for the same reason `target-fs.ts`'s `targetFsListErrorV1`
 * does: an unexpected failure becomes a reply the wizard can show and fall
 * back to manual entry from, rather than a hang with no answer at all.
 */
export const sshDiscoveryResultErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string().min(1),
});
export type SshDiscoveryResultErrorV1 = z.infer<typeof sshDiscoveryResultErrorV1>;

export const sshDiscoveryResultV1 = z.discriminatedUnion('outcome', [
  sshDiscoveryResultOkV1,
  sshDiscoveryResultErrorV1,
]);
export type SshDiscoveryResultV1 = z.infer<typeof sshDiscoveryResultV1>;

/** A client asks `nodeId` (the account's already-connected node) to run `discoverSshTargets()` on its own machine. */
export const sshDiscoveryRequest = z.object({
  type: z.literal('ssh_discovery_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
});
export type SshDiscoveryRequest = z.infer<typeof sshDiscoveryRequest>;

/** The acting node's reply, delivered back to the requesting client only — the relay matches it to its pending `ssh_discovery_request` by `requestId`; `nodeId` rides along for clarity, mirroring `provisionProgress`/`provisionTargetResult`'s own convention. */
export const sshDiscoveryResponse = z.object({
  type: z.literal('ssh_discovery_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  result: sshDiscoveryResultV1,
});
export type SshDiscoveryResponse = z.infer<typeof sshDiscoveryResponse>;
