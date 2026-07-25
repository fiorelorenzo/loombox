import type { EncryptedEnvelope } from '@loombox/protocol';
import type { CryptoKey } from './webcrypto-types';
import { base64ToBytes, bytesToBase64 } from './base64';
import { decryptEnvelope, encryptEnvelope, type Envelope } from './envelope';

/**
 * The bridge between this package's `Envelope` (raw `Uint8Array` iv/
 * ciphertext, what `encryptEnvelope`/`decryptEnvelope` actually deal in) and
 * `@loombox/protocol`'s `EncryptedEnvelope` (the base64-encoded JSON shape
 * that actually crosses the WebSocket wire, per `packages/protocol/src/v1/
 * envelope.ts`'s doc comment). Every outgoing session update, session-create
 * private envelope, and prompt-inject payload goes through `sealJson`/
 * `openJson` below so the relay only ever sees the wire shape and every
 * caller — node or client — only ever deals in plain values.
 *
 * Lives in `@loombox/crypto` rather than `@loombox/node` so a client/PWA can
 * import the exact same seal/open implementation the node uses, rather than
 * reimplementing it and risking the two drifting apart.
 */

const ENCRYPTION_ALG = 'AES-256-GCM' as const;

/** Base64-encodes a crypto `Envelope`'s raw bytes into the wire's `EncryptedEnvelope` shape. */
export function envelopeToWire(envelope: Envelope): EncryptedEnvelope {
  return {
    resourceId: envelope.resourceId,
    iv: bytesToBase64(envelope.iv),
    ciphertext: bytesToBase64(envelope.ciphertext),
    alg: ENCRYPTION_ALG,
  };
}

/** The inverse of {@link envelopeToWire}: decodes a wire `EncryptedEnvelope` back into this package's raw-byte `Envelope`. */
export function envelopeFromWire(wire: EncryptedEnvelope): Envelope {
  return {
    resourceId: wire.resourceId,
    iv: base64ToBytes(wire.iv),
    ciphertext: base64ToBytes(wire.ciphertext),
  };
}

/**
 * JSON-serializes `value`, seals it under `key` bound to `resourceId` (§8's
 * swap/spoof-fix AAD binding), and returns the wire-ready base64 form. The
 * relay stores/forwards exactly this shape and never decrypts it.
 */
export async function sealJson(
  resourceId: string,
  value: unknown,
  key: CryptoKey,
): Promise<EncryptedEnvelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const envelope = await encryptEnvelope(resourceId, plaintext, key);
  return envelopeToWire(envelope);
}

/**
 * The inverse of {@link sealJson}: decodes and opens a wire `EncryptedEnvelope`
 * under `key`, requiring it to have been sealed for `resourceId` (the
 * caller's own, independently-known expected id — never trusted off the wire
 * envelope's own `resourceId` field, per `envelope.ts`'s `decryptEnvelope`
 * doc comment), and JSON-parses the result.
 */
export async function openJson<T>(
  resourceId: string,
  wire: EncryptedEnvelope,
  key: CryptoKey,
): Promise<T> {
  const envelope = envelopeFromWire(wire);
  const plaintext = await decryptEnvelope(resourceId, envelope, key);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
