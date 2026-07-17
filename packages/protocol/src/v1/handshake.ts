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
 * The handshake a node or client sends immediately on connecting (ACP
 * `initialize` pattern, SPEC §16). `authToken` is an opaque Better Auth
 * Bearer token (§8) — this package validates only its shape as a non-empty
 * string, never its contents. `devicePublicKey` is this device's ECDH P-256
 * identity key, base64-encoded raw form (`@loombox/crypto`'s
 * `exportPublicKeyRaw`, §8).
 */
export const initialize = z.object({
  type: z.literal('initialize'),
  protocolVersion: z.literal(PROTOCOL_V1),
  role: wireRole,
  authToken: z.string().min(1),
  deviceId: z.string().min(1),
  devicePublicKey: base64String,
});
export type Initialize = z.infer<typeof initialize>;

/**
 * The relay's reply to {@link initialize}: the version this connection
 * actually negotiated (which {@link negotiateVersion} may resolve below this
 * schema's own `protocolVersion`, e.g. `0`, if the peer is v0-only) plus the
 * capability set the connection may use (SPEC §5.5's capability-negotiation
 * pattern, applied at the connection level rather than the ACP-session
 * level).
 */
export const initializeResult = z.object({
  type: z.literal('initialize_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  negotiatedVersion: z.number().int().nonnegative(),
  capabilities: z.array(z.string()),
});
export type InitializeResult = z.infer<typeof initializeResult>;
