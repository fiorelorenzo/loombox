import type { WrappedAmkBlob } from '@loombox/crypto';
import type { EncryptedEnvelope } from '@loombox/protocol';

/**
 * The wire shape between `RelayClient` (main thread) and the envelope-crypto
 * worker (issue #756, SPEC §8) — or, in an environment with no `Worker`
 * global (Node/vitest), between the same request/response shapes and
 * `envelope-crypto-client.ts`'s in-process fallback. Every field here is
 * either plain JSON or a `Uint8Array`/`ArrayBuffer`, so it structured-clones
 * across `postMessage` with no manual (de)serialization.
 *
 * Three key families, matching `@loombox/crypto/session-keys.ts`'s
 * documented derivation paths plus this app's own `['target', ...]` family
 * (`crypto-worker-engine.ts`'s `deriveTargetKey`): `'session'`, `'project'`,
 * `'target'`. `keyId` picks which key within that family (sessionId /
 * projectPath / targetId); `resourceId` is what the envelope's AAD is bound
 * to — almost always equal to `keyId`, except an attachment upload binds to
 * `attachmentResourceId(sessionId, ref)` while still deriving the *session*
 * key (see `crypto-worker-engine.ts`'s `sealBytes`).
 */
export type EnvelopeKeyKind = 'session' | 'project' | 'target';

/**
 * Sent exactly once, synchronously, before any other message (guaranteed by
 * `postMessage`'s FIFO delivery to the same target) — hands the worker the
 * account's AMK and every subsequent request derives session/project/target
 * keys from it locally, with no further round trip. `amk`'s buffer is
 * transferred (not copied) by the caller, so the main thread's own
 * transient copy is detached the instant this is posted — see
 * `envelope-crypto-client.ts`'s `WorkerEnvelopeCrypto` constructor.
 */
export interface EnvelopeInitMessage {
  readonly type: 'init';
  readonly amk: Uint8Array;
  readonly accountId: string;
}

export interface EnvelopeOpenRequest {
  readonly type: 'open';
  readonly requestId: number;
  readonly keyKind: EnvelopeKeyKind;
  readonly keyId: string;
  readonly resourceId: string;
  readonly wire: EncryptedEnvelope;
}

export interface EnvelopeSealRequest {
  readonly type: 'seal';
  readonly requestId: number;
  readonly keyKind: EnvelopeKeyKind;
  readonly keyId: string;
  readonly resourceId: string;
  readonly value: unknown;
}

/** Raw-bytes sealing (attachments) — the one caller that doesn't go through `sealJson`. */
export interface EnvelopeSealBytesRequest {
  readonly type: 'seal-bytes';
  readonly requestId: number;
  readonly keyKind: EnvelopeKeyKind;
  readonly keyId: string;
  readonly resourceId: string;
  readonly bytes: Uint8Array;
}

/** `RelayClient.escrowAmk`'s request: wrap the worker's own held AMK under a Recovery Code (SPEC §8 path 2). The raw AMK itself never crosses back — only the resulting `WrappedAmkBlob`, which is ciphertext. */
export interface EnvelopeWrapAmkRequest {
  readonly type: 'wrap-amk';
  readonly requestId: number;
  readonly recoveryCode: string;
}

export type EnvelopeRequest =
  EnvelopeOpenRequest | EnvelopeSealRequest | EnvelopeSealBytesRequest | EnvelopeWrapAmkRequest;

/** Structured-clone-safe error info — deliberately not the native `Error`/`DOMException` object itself, so a decrypt failure (e.g. `crypto.subtle.decrypt`'s `OperationError`) reconstructs identically regardless of which engine/browser produced it. */
export interface EnvelopeErrorInfo {
  readonly name: string;
  readonly message: string;
}

export type EnvelopeResponse =
  | {
      readonly requestId: number;
      readonly ok: true;
      readonly kind: 'open';
      readonly value: unknown;
    }
  | {
      readonly requestId: number;
      readonly ok: true;
      readonly kind: 'seal' | 'seal-bytes';
      readonly wire: EncryptedEnvelope;
    }
  | {
      readonly requestId: number;
      readonly ok: true;
      readonly kind: 'wrap-amk';
      readonly blob: WrappedAmkBlob;
    }
  | { readonly requestId: number; readonly ok: false; readonly error: EnvelopeErrorInfo };
