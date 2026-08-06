import type { webcrypto } from 'node:crypto';
import {
  deriveKeyTree,
  deriveProjectKey,
  deriveSessionKey,
  encryptEnvelope,
  envelopeToWire,
  importAesGcmKey,
  openJson,
  sealJson,
  wrapAmkWithRecoveryCode,
  type WrappedAmkBlob,
} from '@loombox/crypto';
import type { EncryptedEnvelope } from '@loombox/protocol';
import type { EnvelopeKeyKind, EnvelopeRequest, EnvelopeResponse } from './crypto-worker-protocol';

// Same alias trick `relay-client.ts` uses: resolves to the browser lib.dom
// `CryptoKey` in apps/web's own tsconfig, to Node's `webcrypto.CryptoKey` in
// a Node-only consumer — `crypto.subtle` is the identical global either way.
type CryptoKey = webcrypto.CryptoKey;

/**
 * `['target', accountId, targetId]` (SPEC §7.25's directory picker; issue
 * #474) — no session-derived key exists yet when just browsing a target.
 * Moved here verbatim from `relay-client.ts` (issue #756): this is now the
 * only place in the client that still calls it, since every session/
 * project/target key derivation lives inside the worker engine. Duplicated
 * verbatim in `packages/node/src/node-daemon.ts`'s own `deriveTargetKey` —
 * see that copy's doc comment for why it isn't promoted into
 * `@loombox/crypto` alongside `deriveSessionKey`/`deriveProjectKey`.
 */
async function deriveTargetKey(
  amk: Uint8Array,
  accountId: string,
  targetId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['target', accountId, targetId]);
  return importAesGcmKey(node.key);
}

/**
 * Owns the AMK and every session/project/target-scoped key derived from it,
 * plus the AEAD open/seal operations that use them (SPEC §8) — the only
 * class in this app that still touches `crypto.subtle` for session traffic.
 *
 * Deliberately has no `self`/`postMessage`/`Worker` awareness of its own:
 * `crypto-worker.ts` wraps one instance inside the worker (the browser/
 * Electron path), and `envelope-crypto-client.ts`'s `InlineEnvelopeCrypto`
 * wraps another directly on the caller's own thread (the Node/vitest
 * fallback, used when no `Worker` global exists). Both paths run the exact
 * same class, so they are provably the same behavior, not two
 * implementations that could quietly drift apart.
 */
export class EnvelopeCryptoEngine {
  private readonly amk: Uint8Array;
  private readonly accountId: string;
  private readonly sessionKeys = new Map<string, Promise<CryptoKey>>();
  private readonly projectKeys = new Map<string, Promise<CryptoKey>>();
  private readonly targetKeys = new Map<string, Promise<CryptoKey>>();

  constructor(amk: Uint8Array, accountId: string) {
    this.amk = amk;
    this.accountId = accountId;
  }

  private cached(
    map: Map<string, Promise<CryptoKey>>,
    keyId: string,
    derive: () => Promise<CryptoKey>,
  ): Promise<CryptoKey> {
    let key = map.get(keyId);
    if (!key) {
      key = derive();
      map.set(keyId, key);
    }
    return key;
  }

  private keyFor(keyKind: EnvelopeKeyKind, keyId: string): Promise<CryptoKey> {
    switch (keyKind) {
      case 'session':
        return this.cached(this.sessionKeys, keyId, () =>
          deriveSessionKey(this.amk, this.accountId, keyId),
        );
      case 'project':
        return this.cached(this.projectKeys, keyId, () =>
          deriveProjectKey(this.amk, this.accountId, keyId),
        );
      case 'target':
        return this.cached(this.targetKeys, keyId, () =>
          deriveTargetKey(this.amk, this.accountId, keyId),
        );
    }
  }

  async open(
    keyKind: EnvelopeKeyKind,
    keyId: string,
    resourceId: string,
    wire: EncryptedEnvelope,
  ): Promise<unknown> {
    const key = await this.keyFor(keyKind, keyId);
    return openJson(resourceId, wire, key);
  }

  async seal(
    keyKind: EnvelopeKeyKind,
    keyId: string,
    resourceId: string,
    value: unknown,
  ): Promise<EncryptedEnvelope> {
    const key = await this.keyFor(keyKind, keyId);
    return sealJson(resourceId, value, key);
  }

  async sealBytes(
    keyKind: EnvelopeKeyKind,
    keyId: string,
    resourceId: string,
    bytes: Uint8Array,
  ): Promise<EncryptedEnvelope> {
    const key = await this.keyFor(keyKind, keyId);
    const envelope = await encryptEnvelope(resourceId, bytes, key);
    return envelopeToWire(envelope);
  }

  async wrapAmkForEscrow(recoveryCode: string): Promise<WrappedAmkBlob> {
    return wrapAmkWithRecoveryCode(this.amk, recoveryCode, this.accountId);
  }

  private async handleOne(request: EnvelopeRequest): Promise<EnvelopeResponse> {
    try {
      switch (request.type) {
        case 'open': {
          const value = await this.open(
            request.keyKind,
            request.keyId,
            request.resourceId,
            request.wire,
          );
          return { requestId: request.requestId, ok: true, kind: 'open', value };
        }
        case 'seal': {
          const wire = await this.seal(
            request.keyKind,
            request.keyId,
            request.resourceId,
            request.value,
          );
          return { requestId: request.requestId, ok: true, kind: 'seal', wire };
        }
        case 'seal-bytes': {
          const wire = await this.sealBytes(
            request.keyKind,
            request.keyId,
            request.resourceId,
            request.bytes,
          );
          return { requestId: request.requestId, ok: true, kind: 'seal-bytes', wire };
        }
        case 'wrap-amk': {
          const blob = await this.wrapAmkForEscrow(request.recoveryCode);
          return { requestId: request.requestId, ok: true, kind: 'wrap-amk', blob };
        }
      }
    } catch (error) {
      const errorInfo =
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) };
      return { requestId: request.requestId, ok: false, error: errorInfo };
    }
  }

  /**
   * One request -> one settled response, `requests`' own order preserved in
   * the returned array regardless of which one's `crypto.subtle` call
   * actually finishes first (`Promise.all`'s contract) — this IS the batch
   * decrypt E3-4 asked for. A single corrupt/tampered envelope only fails
   * its own slot (`handleOne`'s try/catch turns a rejection into an
   * `ok: false` response instead of letting it reject `Promise.all` itself),
   * so one bad envelope in a burst never drops the rest of the batch.
   */
  async handleBatch(requests: readonly EnvelopeRequest[]): Promise<EnvelopeResponse[]> {
    return Promise.all(requests.map((request) => this.handleOne(request)));
  }
}
