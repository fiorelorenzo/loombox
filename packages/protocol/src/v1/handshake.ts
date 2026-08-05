import { z } from 'zod';
import { base64String } from './envelope';

/**
 * v1 of the wire protocol (SPEC §10, §16, issue #315). Bump this (and add a
 * new `PROTOCOL_V2`, never mutate this one) on the next backwards-
 * incompatible schema change. v0's `PROTOCOL_VERSION = 0` (`../index.ts`)
 * stays intact and unrelated; this package now speaks both.
 */
export const PROTOCOL_V1 = 1;

/**
 * Every wire-protocol version this package knows how to validate, v0
 * included. Not itself sent on the wire — it is the local input to
 * {@link negotiateVersion} for a peer that supports the full range this
 * package implements.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<number> = new Set([0, PROTOCOL_V1]);

/**
 * Pure highest-common-version negotiation (SPEC §10, §16: "protocol version
 * negotiated once per connection following ACP's `initialize` handshake").
 * Takes each side's own list of supported versions — never reads either
 * peer's wire messages directly, so it is trivially unit-testable and reusable
 * by relay, node, and client alike. Returns the highest version present in
 * both lists, or `null` if the two peers share no common version.
 */
export function negotiateVersion(
  localVersions: readonly number[],
  remoteVersions: readonly number[],
): number | null {
  const remoteSet = new Set(remoteVersions);
  let best: number | null = null;
  for (const version of localVersions) {
    if (remoteSet.has(version) && (best === null || version > best)) {
      best = version;
    }
  }
  return best;
}

/** Fields every v1 wire message carries so the receiver can gate on version, mirroring v0's `baseMessage`. */
export const baseMessageV1 = z.object({
  protocolVersion: z.literal(PROTOCOL_V1),
});
export type BaseMessageV1 = z.infer<typeof baseMessageV1>;

/** Which side of a connection a device is registering as. */
export const wireRole = z.enum(['node', 'client']);
export type WireRole = z.infer<typeof wireRole>;

/**
 * A component's build identity (issue #655): which `package.json` version
 * and, when honestly recoverable, which commit produced the code actually
 * running. Exists because `protocolVersion` alone is too coarse to catch
 * drift — it bumps only on a breaking wire change, so two peers built a
 * week and fifty PRs apart both announce the same `PROTOCOL_V1` and shake
 * hands happily, then silently disagree about what a field means (the real
 * incident behind this issue: #623's four ACP field-mapping fixes were
 * exactly this class of bug).
 *
 * `commit` is independently optional: a component whose runtime genuinely
 * cannot recover its own commit still sends `version` alone rather than
 * omitting the whole identity — see `@loombox/node`'s and
 * `@loombox/relay`'s own `build-identity.ts` for each component's actual
 * resolution order and why nothing here invents a second source for either
 * field (`package.json` and the release's own recorded commit already
 * exist).
 *
 * Never parsed for ordering or feature meaning — issue #655's own
 * constraint. A receiver only ever asks "is this identical to the build
 * I'm comparing against" ({@link buildIdentityMismatch}), never "is this
 * newer than X therefore feature Y is available." Feature detection stays
 * `protocolVersion`'s job, not this one's.
 */
export const buildIdentityV1 = z.object({
  version: z.string().min(1),
  commit: z.string().min(1).optional(),
});
export type BuildIdentityV1 = z.infer<typeof buildIdentityV1>;

/**
 * Pure, order-blind comparison between two build identities (issue #655):
 * whether `remote` is a KNOWN-different build from `local`, never whether
 * either is older/newer — see {@link buildIdentityV1}'s own doc comment for
 * why this package refuses to encode any ordering. Returns `false` whenever
 * either side is absent: a peer that predates `buildIdentity` entirely (the
 * enum-widening precedent `session-events.ts`'s `sessionStatusV1` doc
 * comment sets — an older peer simply never sends the field) sends nothing
 * to disagree with, and treating "unknown" as "behind" would be a claim
 * this function can't back up.
 *
 * Compares `commit` when both sides have one — the precise signal a real
 * deploy/checkout provides — and falls back to `version` only when a
 * commit is missing on either side (a component whose runtime can't
 * recover its own commit today; see `buildIdentityV1`'s doc comment).
 */
export function buildIdentityMismatch(
  local: BuildIdentityV1 | undefined,
  remote: BuildIdentityV1 | undefined,
): boolean {
  if (!local || !remote) return false;
  if (local.commit && remote.commit) return local.commit !== remote.commit;
  return local.version !== remote.version;
}

/**
 * The handshake a node or client sends immediately on connecting (ACP
 * `initialize` pattern, SPEC §16). `authToken` is an opaque Better Auth
 * Bearer token (§8) — this package validates only its shape as a non-empty
 * string, never its contents. `devicePublicKey` is this device's ECDH P-256
 * identity key, base64-encoded raw form (`@loombox/crypto`'s
 * `exportPublicKeyRaw`, §8). `buildIdentity` (issue #655) is additive and
 * optional exactly like `sessionStatusV1`'s widenings: a node/client built
 * before this field existed simply never sends it, and this schema still
 * parses that payload — see `relay.ts`'s own comment on what an absent
 * identity means downstream (never treated as a mismatch).
 */
export const initialize = z.object({
  type: z.literal('initialize'),
  protocolVersion: z.literal(PROTOCOL_V1),
  role: wireRole,
  authToken: z.string().min(1),
  deviceId: z.string().min(1),
  devicePublicKey: base64String,
  buildIdentity: buildIdentityV1.optional(),
});
export type Initialize = z.infer<typeof initialize>;

/**
 * The relay's reply to {@link initialize}: the version this connection
 * actually negotiated (which {@link negotiateVersion} may resolve below this
 * schema's own `protocolVersion`, e.g. `0`, if the peer is v0-only) plus the
 * capability set the connection may use (SPEC §5.5's capability-negotiation
 * pattern, applied at the connection level rather than the ACP-session
 * level). `buildIdentity` (issue #655) is this RELAY's own build identity —
 * "what is actually being served" — the baseline a client compares a
 * node's `TargetListEntry.build` against; optional for the same reason as
 * {@link initialize}'s own field: an older relay never sends it.
 */
export const initializeResult = z.object({
  type: z.literal('initialize_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  negotiatedVersion: z.number().int().nonnegative(),
  capabilities: z.array(z.string()),
  buildIdentity: buildIdentityV1.optional(),
});
export type InitializeResult = z.infer<typeof initializeResult>;
