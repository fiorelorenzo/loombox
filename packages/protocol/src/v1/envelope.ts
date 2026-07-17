import { z } from 'zod';

/**
 * The JSON-safe wire form of `@loombox/crypto`'s `Envelope` (SPEC §8, §16).
 * `packages/crypto/src/envelope.ts` deals in raw `Uint8Array`s for `iv` and
 * `ciphertext`, which cannot travel through `JSON.stringify`/WebSocket frames
 * as-is; this schema is the base64-encoded shape that actually crosses the
 * wire. The relay only ever forwards/stores this shape and never decrypts
 * it (§5.3, §8) — every session/resource-content family below carries one of
 * these instead of re-declaring its own crypto envelope.
 */

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** True for a non-empty, correctly-padded base64 string. */
function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

/** A base64-encoded byte string, as required for every binary wire field. */
export const base64String = z.string().refine(isBase64, {
  message: 'must be a base64-encoded string',
});
export type Base64String = z.infer<typeof base64String>;

/** v1 ships exactly one AEAD algorithm; the field is still explicit on the wire for forward-compat. */
export const encryptionAlg = z.literal('AES-256-GCM');
export type EncryptionAlg = z.infer<typeof encryptionAlg>;

/**
 * The wire form of an AAD-bound sealed envelope (`@loombox/crypto`'s
 * `Envelope`, base64-encoded). `resourceId` is the AAD binding target
 * (SPEC §8's swap/spoof fix); `iv`/`ciphertext` are opaque base64 blobs the
 * relay forwards/stores without ever decrypting.
 */
export const encryptedEnvelope = z.object({
  resourceId: z.string().min(1),
  iv: base64String,
  ciphertext: base64String,
  alg: encryptionAlg,
});
export type EncryptedEnvelope = z.infer<typeof encryptedEnvelope>;
