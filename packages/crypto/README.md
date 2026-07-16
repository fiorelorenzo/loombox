# @loombox/crypto

End-to-end crypto primitives for loombox (SPEC §8, §16).

## Curve decision: P-256 (not X25519)

loombox uses **ECDH P-256** via the WebCrypto `SubtleCrypto` API, with
**AES-256-GCM** for symmetric sealing. This is grounded in Nimbalyst's
`TrackerEnvelopeCrypto.ts` / `ECDHKeyManager.ts` (per-device ECDH P-256 keys,
AAD-bound resource id). SPEC §16 explicitly flags: pick ONE curve, do not blend
Happy's X25519/tweetnacl into the same design. That decision is recorded here so
it is not relitigated later.

Envelopes bind the resource id into the AAD (Nimbalyst's fix for a real spoofing
hole its own comments describe).

## Status: bootstrap

This package exports typed, throwing stubs (`deriveKey`, `wrapKey`,
`encryptEnvelope`, `decryptEnvelope`) so downstream packages can compile against
the shape. There is no live key derivation yet. v0 is transport-only (TLS +
Tailscale), so real E2E crypto is deferred to the security/crypto epic.
