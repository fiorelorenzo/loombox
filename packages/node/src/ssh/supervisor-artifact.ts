import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

import type { RemoteOsArch } from './remote-runtime';

/**
 * A staged agent-supervisor build for one OS/arch (issue #86, SPEC §7.23
 * "Signed supervisor"): today's honest scope is "the node runtime + the
 * supervisor entry point that runs on it" (there is no separate compiled
 * supervisor binary yet — `@loombox/supervisor` runs as node code, same as
 * this package), so `bytes` is whatever payload a future
 * {@link SupervisorArtifactSource} produces for that (a tarball, a bundled
 * script, ...); this module doesn't care about its internal shape, only that
 * it is verifiably signed before it is ever staged on or executed by a
 * remote host.
 */
export interface SupervisorArtifact {
  version: string;
  bytes: Uint8Array;
  /**
   * Ed25519 signature over `bytes` (SPEC §16: "minisign (pinned Ed25519 key,
   * matches 'pinned public key')"), or `undefined` for an explicitly
   * unsigned artifact — {@link verifySupervisorArtifact} refuses that case
   * exactly like an invalid signature, never treats "unsigned" as "trust it
   * anyway".
   */
  signature: Uint8Array | undefined;
}

/**
 * Where a {@link SupervisorArtifact} comes from for a given remote OS/arch
 * and target version. Deliberately just an interface: issue #86's honest
 * scope is staging what the remote needs, verified, via *some* source; a
 * real "fetch the matching build from GitHub Releases" implementation
 * (SPEC §16's grounding note) is a follow-up that slots in here once the
 * supervisor actually has signed releases to fetch — this module doesn't
 * assume, or fake, that it exists yet.
 */
export interface SupervisorArtifactSource {
  fetch(osArch: RemoteOsArch, version: string): Promise<SupervisorArtifact>;
}

export type ArtifactVerifyFailureReason = 'missing_signature' | 'invalid_signature';

export type ArtifactVerifyResult =
  { ok: true } | { ok: false; reason: ArtifactVerifyFailureReason; message: string };

/** Builds the Ed25519 `KeyObject` `crypto.verify` needs from a raw 32-byte public key, via a JWK (RFC 8037) — no extra dependency beyond Node's own `node:crypto` (which has shipped Ed25519 support since Node 12). */
function toEd25519PublicKey(publicKeyRaw: Uint8Array): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyRaw).toString('base64url') },
    format: 'jwk',
  });
}

/**
 * Verifies `artifact.signature` against `publicKeyRaw` (this node's pinned
 * Ed25519 public key) — the trust boundary issue #86 exists for: this MUST
 * be called, and its result checked, before an artifact's bytes are ever
 * copied to or executed on a remote host (see
 * `supervisor-provisioning.ts`'s `planSupervisorProvisioning`, which does
 * exactly that and never lets `executeSupervisorProvisioning` see an
 * artifact this function rejected).
 *
 * A tampered artifact (bytes changed after signing) and one signed by the
 * wrong key both surface as `'invalid_signature'` — the same outcome a
 * separate "checksum mismatch" check would produce, since a signature over
 * the exact bytes already subsumes a plain checksum (any byte change
 * invalidates it). A missing/empty signature is refused as
 * `'missing_signature'`, kept distinct so a caller/log can tell "someone
 * tampered with this" apart from "this was never signed at all".
 */
export function verifySupervisorArtifact(
  artifact: Pick<SupervisorArtifact, 'bytes' | 'signature'>,
  publicKeyRaw: Uint8Array,
): ArtifactVerifyResult {
  if (!artifact.signature || artifact.signature.length === 0) {
    return {
      ok: false,
      reason: 'missing_signature',
      message: 'supervisor artifact has no signature; refusing to stage or execute it',
    };
  }

  const publicKey = toEd25519PublicKey(publicKeyRaw);
  const valid = cryptoVerify(
    null,
    Buffer.from(artifact.bytes),
    publicKey,
    Buffer.from(artifact.signature),
  );
  if (!valid) {
    return {
      ok: false,
      reason: 'invalid_signature',
      message:
        'supervisor artifact signature does not match the pinned public key (tampered, ' +
        'checksum-mismatched, or signed by an untrusted key); refusing to stage or execute it',
    };
  }

  return { ok: true };
}
