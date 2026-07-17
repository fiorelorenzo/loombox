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
 *
 * Built entirely on WebCrypto (`crypto.subtle` + `crypto.getRandomValues`),
 * not Node's `crypto` builtin (issue #324): Vite externalizes that builtin
 * for the browser build, so a client/PWA importing this module would throw
 * the moment it tried to derive a key. `crypto.subtle` is a global in both Node
 * 22 and every browser, so this runs identically on both — the tradeoff is
 * that `crypto.subtle.sign` is async, so `deriveChild`/`deriveKeyTree` are
 * too (unlike the old synchronous `createHmac` version).
 */
const AMK_BYTES = 32; // 256 bits.
const HMAC_SHA512_DIGEST_BYTES = 64;
const HALF_BYTES = HMAC_SHA512_DIGEST_BYTES / 2; // 32 bytes each for key / chainCode.
const HMAC_SHA512_ALGORITHM = { name: 'HMAC', hash: 'SHA-512' } as const;

/** A node in the key tree: a 32-byte key and the 32-byte chain code used to derive its children. */
export interface KeyTreeNode {
  readonly key: Uint8Array;
  readonly chainCode: Uint8Array;
}

/** Generates a fresh 256-bit Account Master Key from CSPRNG randomness. */
export function generateAmk(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(AMK_BYTES));
}

/**
 * Derives one child node as `hmac_sha512(chainCode, data)`, split into the
 * first 32 bytes (the child's key) and the last 32 bytes (the child's chain
 * code, used to derive its own children). This is the tree's sole primitive;
 * `deriveKeyTree` below just walks it once per path segment.
 */
export async function deriveChild(chainCode: Uint8Array, data: Uint8Array): Promise<KeyTreeNode> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    // The cast is a type-only workaround for a known friction point between
    // @types/node's `Uint8Array<ArrayBufferLike>` and lib.dom.d.ts's WebCrypto
    // methods, which require the narrower `Uint8Array<ArrayBuffer>`, when a
    // consumer's tsconfig includes both (e.g. apps/web's browser + Node types
    // combo) — no runtime effect, WebCrypto accepts any `ArrayBufferView`.
    chainCode as Uint8Array<ArrayBuffer>,
    HMAC_SHA512_ALGORITHM,
    false,
    ['sign'],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, data as Uint8Array<ArrayBuffer>),
  );
  return {
    key: digest.slice(0, HALF_BYTES),
    chainCode: digest.slice(HALF_BYTES, HMAC_SHA512_DIGEST_BYTES),
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
export async function deriveKeyTree(
  amk: Uint8Array,
  path: readonly string[],
): Promise<KeyTreeNode> {
  let node: KeyTreeNode = { key: amk, chainCode: amk };
  for (const segment of path) {
    node = await deriveChild(node.chainCode, new TextEncoder().encode(segment));
  }
  return node;
}
