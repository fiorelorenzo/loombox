/**
 * @loombox/crypto — E2E crypto primitives (SPEC §8, §16).
 *
 * BOOTSTRAP ONLY. These are typed, throwing stubs so downstream packages can
 * compile against the shape; the real envelope / Account Master Key
 * implementation lands under the security/crypto epic. v0 is transport-only
 * (TLS + Tailscale WireGuard), so no live crypto is wired yet.
 *
 * Curve decision: ECDH **P-256** via WebCrypto (SubtleCrypto), with AES-256-GCM
 * for symmetric sealing. Grounded in Nimbalyst's TrackerEnvelopeCrypto /
 * ECDHKeyManager (SPEC §16). We deliberately pick ONE curve — P-256 — and do
 * NOT blend in Happy's X25519/tweetnacl. See README.md.
 */

const notImplemented = (fn: string): never => {
  throw new Error(`@loombox/crypto: ${fn}() is not implemented yet (bootstrap stub)`);
};

/** An AAD-bound sealed envelope (the AAD binds a resource id, SPEC §16). */
export interface Envelope {
  readonly resourceId: string;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export function deriveKey(..._args: unknown[]): never {
  return notImplemented('deriveKey');
}

export function wrapKey(..._args: unknown[]): never {
  return notImplemented('wrapKey');
}

export function encryptEnvelope(..._args: unknown[]): never {
  return notImplemented('encryptEnvelope');
}

export function decryptEnvelope(..._args: unknown[]): never {
  return notImplemented('decryptEnvelope');
}
