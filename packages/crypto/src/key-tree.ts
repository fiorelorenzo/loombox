/**
 * Account Master Key (AMK) and HMAC-SHA512 BIP32-style key-tree derivation
 * (SPEC §8, §16). Every account holds one 256-bit AMK; every session/resource
 * key is derived from it via a key tree so any device holding the AMK can
 * derive every past and future key on its own, with no other device online
 * to hand over a wrapped copy.
 *
 * This is Happy's actual construction — `deriveSecretKeyTreeRoot` /
 * `deriveSecretKeyTreeChild`, each child computed as `hmac_sha512(chainCode,
 * data)` and split into a key half and a chain-code half — reimplemented
 * clean-room from the SPEC's description, not copied. It is deliberately
 * **not** RFC 5869 HKDF (see the "not HKDF" test in key-tree.test.ts).
 */
import { createHmac, randomBytes } from 'node:crypto';

const AMK_BYTES = 32; // 256 bits.
const HMAC_SHA512_DIGEST_BYTES = 64;
const HALF_BYTES = HMAC_SHA512_DIGEST_BYTES / 2; // 32 bytes each for key / chainCode.

/** A node in the key tree: a 32-byte key and the 32-byte chain code used to derive its children. */
export interface KeyTreeNode {
  readonly key: Uint8Array;
  readonly chainCode: Uint8Array;
}

/** Generates a fresh 256-bit Account Master Key from CSPRNG randomness. */
export function generateAmk(): Uint8Array {
  return new Uint8Array(randomBytes(AMK_BYTES));
}

/**
 * Derives one child node as `hmac_sha512(chainCode, data)`, split into the
 * first 32 bytes (the child's key) and the last 32 bytes (the child's chain
 * code, used to derive its own children). This is the tree's sole primitive;
 * `deriveKeyTree` below just walks it once per path segment.
 */
export function deriveChild(chainCode: Uint8Array, data: Uint8Array): KeyTreeNode {
  const digest = createHmac('sha512', chainCode).update(data).digest();
  return {
    key: new Uint8Array(digest.subarray(0, HALF_BYTES)),
    chainCode: new Uint8Array(digest.subarray(HALF_BYTES, HMAC_SHA512_DIGEST_BYTES)),
  };
}

/**
 * Walks the key tree from the AMK root down `path`, one {@link deriveChild}
 * call per segment (each segment UTF-8 encoded). The AMK itself is both the
 * root's key and its chain code — `deriveKeyTree(amk, [])` returns the AMK
 * unchanged; real call sites always pass a non-empty path, e.g.
 * `['session', sessionId]` or `['device', deviceId]`, so two different
 * resources never share a derived key even though they share one AMK.
 */
export function deriveKeyTree(amk: Uint8Array, path: readonly string[]): KeyTreeNode {
  let node: KeyTreeNode = { key: amk, chainCode: amk };
  for (const segment of path) {
    node = deriveChild(node.chainCode, new TextEncoder().encode(segment));
  }
  return node;
}
