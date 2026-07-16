# @loombox/crypto

End-to-end crypto primitives for loombox (SPEC §8, §16). No external
dependencies — everything is built on Node 22's global WebCrypto
(`crypto.subtle`) and `node:crypto` (`createHmac`, `randomBytes`).

## Curve decision: P-256 (not X25519)

loombox uses **ECDH P-256** via the WebCrypto `SubtleCrypto` API, with
**AES-256-GCM** for symmetric sealing. This is grounded in Nimbalyst's
`TrackerEnvelopeCrypto.ts` / `ECDHKeyManager.ts` (per-device ECDH P-256 keys,
AAD-bound resource id). SPEC §16 explicitly flags: pick ONE curve, do not blend
Happy's X25519/tweetnacl into the same design. That decision is recorded here so
it is not relitigated later.

Envelopes bind the resource id into the AAD (Nimbalyst's fix for a real spoofing
hole its own comments describe).

## Modules

- `ecdh.ts` — per-device ECDH P-256 identity keypairs: `generateEcdhKeyPair`,
  `exportPublicKeyRaw` / `importPublicKeyRaw` (raw uncompressed EC point,
  0x04 || X || Y), and `deriveSharedSecretBits` for a two-party ECDH exchange.
- `aead.ts` — AES-256-GCM primitives: `importAesGcmKey` (32 raw bytes → a
  non-extractable `CryptoKey`), `aesGcmEncrypt` / `aesGcmDecrypt` with an
  explicit caller-supplied AAD, a random 96-bit IV by default, and a 128-bit
  tag.
- `envelope.ts` — the AAD-bound envelope helper: `encryptEnvelope(resourceId,
plaintext, key)` → `{ resourceId, iv, ciphertext }`, and
  `decryptEnvelope(resourceId, envelope, key)`. The `resourceId` passed to
  `decryptEnvelope` is the caller's own, independently-known expected id (e.g.
  the id of the row/path the envelope was just fetched from), not trusted off
  `envelope.resourceId` — an attacker could relabel that field too. If the
  envelope was actually sealed for a different resource id, the AES-GCM tag
  check fails and decryption rejects loudly instead of silently opening under
  the wrong context.
- `key-tree.ts` — the Account Master Key and its key-tree derivation, see
  below.

## Key custody: the Account Master Key (AMK)

Every account holds one 256-bit **Account Master Key**, generated once at
first-device setup (`generateAmk()`, CSPRNG randomness via `node:crypto`'s
`randomBytes`). Every session/resource key is derived from it via an
**HMAC-SHA512 BIP32-style key tree** — Happy's actual construction
(`deriveSecretKeyTreeRoot`/`deriveSecretKeyTreeChild`,
`happy/packages/happy-app/sources/encryption/deriveKey.ts:8-30`), reimplemented
clean-room from the SPEC's description of the mechanism, not copied from the
source. A device that holds the AMK can derive every past and future
session/resource key on its own, without any other device needing to be online
to re-wrap anything for it.

This is **not** RFC 5869 HKDF. Each child is computed as `hmac_sha512(chainCode,
data)` and the 64-byte digest is split into two 32-byte halves: the first half
is the child's key, the second half is its chain code (used to derive its own
children in turn). `key-tree.test.ts` includes a test that runs the same
`(chainCode, data)` pair through Node's real `hkdfSync('sha512', ...)` and
asserts the bytes differ from our construction, so a future refactor toward
HKDF would fail loudly rather than silently drift.

```ts
import { generateAmk, deriveKeyTree, deriveChild } from '@loombox/crypto';

const amk = generateAmk(); // 32 bytes, generated once per account

// Walk the tree from the AMK root, one hmac_sha512(chainCode, data) step per
// path segment. Two different resources never share a derived key even
// though they share one AMK.
const sessionKey = deriveKeyTree(amk, ['session', sessionId]);
const deviceKey = deriveKeyTree(amk, ['device', deviceId]);

// deriveChild is the tree's sole primitive; deriveKeyTree just walks it.
const step = deriveChild(amk, new TextEncoder().encode('session'));
```

`deriveKeyTree(amk, [])` returns the AMK itself unchanged (it is both the
root's key and its chain code) — real call sites always pass a non-empty path.

## Putting it together

```ts
import {
  generateAmk,
  deriveKeyTree,
  importAesGcmKey,
  encryptEnvelope,
  decryptEnvelope,
} from '@loombox/crypto';

const amk = generateAmk();
const node = deriveKeyTree(amk, ['session', 'session-1']);
const key = await importAesGcmKey(node.key);

const envelope = await encryptEnvelope('session-1', plaintext, key);
const decrypted = await decryptEnvelope('session-1', envelope, key);
```

Per-device ECDH (`ecdh.ts`) is used separately, for the one legitimate
wrap-fan-out case (revocation: re-wrapping a fresh AMK epoch per remaining
device's public key) and for the QR/short-code pairing fast path — not for
routine session/resource key derivation, which goes through the AMK tree
above.

## Status

Both #110 (ECDH P-256 + AES-256-GCM AAD-bound envelopes) and #111 (AMK +
HMAC-SHA512 key tree) are implemented, with known-answer test vectors covering
both. Not yet wired up: the actual device-registry key-wrap/revocation flow,
recovery-code escrow, and the relay/node integration — those land as
downstream v1 work.
