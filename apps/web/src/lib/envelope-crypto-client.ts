import type { WrappedAmkBlob } from '@loombox/crypto';
import type { EncryptedEnvelope } from '@loombox/protocol';
// Static, literal `?worker` import (issue #756) — see `crypto-worker.ts`'s
// doc comment for why this exact form matters and
// `crypto-worker-load-path.test.ts` for the test that pins it. Vite's
// `?worker` transform compiles the imported default export into a plain
// factory function that only touches the global `Worker` identifier when
// actually CALLED, so this import is safe even in an environment with no
// `Worker` global (verified: `crypto-worker-load-path.test.ts` imports this
// very module under vitest's default `node` environment) — only
// `createEnvelopeCrypto`'s `new CryptoWorker()` call below is guarded.
import CryptoWorker from './crypto-worker?worker';
import { EnvelopeCryptoEngine } from './crypto-worker-engine';
import { MicrotaskBatcher } from './microtask-batcher';
import type {
  EnvelopeErrorInfo,
  EnvelopeInitMessage,
  EnvelopeKeyKind,
  EnvelopeRequest,
  EnvelopeResponse,
} from './crypto-worker-protocol';

/**
 * What `RelayClient` depends on for every session/project/target-scoped
 * envelope operation (issue #756, SPEC §8). `RelayClient` itself never
 * imports `@loombox/crypto`'s AEAD/derivation exports (`openJson`,
 * `sealJson`, `deriveSessionKey`, ...) directly anymore — see
 * `crypto-worker-boundary.test.ts`, which asserts exactly that. Implemented
 * by {@link createEnvelopeCrypto}'s worker-backed path (real browsers/
 * Electron) or its inline fallback (Node/vitest, no `Worker` global) — both
 * share the exact same request/response plumbing in
 * {@link EnvelopeCryptoClientBase} and the exact same crypto in
 * `crypto-worker-engine.ts`'s `EnvelopeCryptoEngine`.
 */
export interface EnvelopeCrypto {
  open<T>(
    keyKind: EnvelopeKeyKind,
    keyId: string,
    resourceId: string,
    wire: EncryptedEnvelope,
  ): Promise<T>;
  seal(
    keyKind: EnvelopeKeyKind,
    keyId: string,
    resourceId: string,
    value: unknown,
  ): Promise<EncryptedEnvelope>;
  sealBytes(
    keyKind: EnvelopeKeyKind,
    keyId: string,
    resourceId: string,
    bytes: Uint8Array,
  ): Promise<EncryptedEnvelope>;
  wrapAmkForEscrow(recoveryCode: string): Promise<WrappedAmkBlob>;
  /** Releases the worker, if any (best-effort, idempotent). */
  dispose(): void;
}

/**
 * The minimal surface {@link WorkerEnvelopeCrypto} needs from a real DOM
 * `Worker` — trivially fakeable in a unit test (`envelope-crypto-client.test.ts`)
 * without a real worker or browser.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  terminate?(): void;
}

function toError(info: EnvelopeErrorInfo): Error {
  const error = new Error(info.message);
  error.name = info.name;
  return error;
}

/** `Omit<EnvelopeRequest, 'requestId'>` would NOT distribute over the union (TS computes `keyof` of a union as the intersection of each member's keys, collapsing every member down to their shared fields) — this conditional does, since a bare type-parameter `extends` check distributes automatically. */
type EnvelopeRequestInput = EnvelopeRequest extends infer R
  ? R extends { requestId: number }
    ? Omit<R, 'requestId'>
    : never
  : never;

/**
 * Shared request/response bookkeeping for both {@link WorkerEnvelopeCrypto}
 * and {@link InlineEnvelopeCrypto}: assigns each call a `requestId`, tracks
 * its pending resolver, and unwraps the eventual {@link EnvelopeResponse}
 * into the typed {@link EnvelopeCrypto} surface (throwing the reconstructed
 * error on `ok: false`, exactly like a rejected `openJson`/`sealJson` call
 * used to before this issue — see those methods' own doc comments). Only
 * *how a request is sent* differs between the two subclasses.
 */
abstract class EnvelopeCryptoClientBase implements EnvelopeCrypto {
  private nextRequestId = 1;
  private readonly pending = new Map<number, (response: EnvelopeResponse) => void>();

  protected abstract dispatch(request: EnvelopeRequest): void;
  abstract dispose(): void;

  protected resolve(response: EnvelopeResponse): void {
    const waiter = this.pending.get(response.requestId);
    if (!waiter) return;
    this.pending.delete(response.requestId);
    waiter(response);
  }

  private send(partial: EnvelopeRequestInput): Promise<EnvelopeResponse> {
    const requestId = this.nextRequestId++;
    const request = { ...partial, requestId } as EnvelopeRequest;
    const { promise, resolve } = Promise.withResolvers<EnvelopeResponse>();
    this.pending.set(requestId, resolve);
    this.dispatch(request);
    return promise;
  }

  async open<T>(
    keyKind: EnvelopeKeyKind,
    keyId: string,
    resourceId: string,
    wire: EncryptedEnvelope,
  ): Promise<T> {
    const response = await this.send({ type: 'open', keyKind, keyId, resourceId, wire });
    if (!response.ok) throw toError(response.error);
    if (response.kind !== 'open') {
      throw new Error(`EnvelopeCrypto: unexpected response kind "${response.kind}" for open()`);
    }
    return response.value as T;
  }

  async seal(
    keyKind: EnvelopeKeyKind,
    keyId: string,
    resourceId: string,
    value: unknown,
  ): Promise<EncryptedEnvelope> {
    const response = await this.send({ type: 'seal', keyKind, keyId, resourceId, value });
    if (!response.ok) throw toError(response.error);
    if (response.kind === 'open' || response.kind === 'wrap-amk') {
      throw new Error(`EnvelopeCrypto: unexpected response kind "${response.kind}" for seal()`);
    }
    return response.wire;
  }

  async sealBytes(
    keyKind: EnvelopeKeyKind,
    keyId: string,
    resourceId: string,
    bytes: Uint8Array,
  ): Promise<EncryptedEnvelope> {
    const response = await this.send({ type: 'seal-bytes', keyKind, keyId, resourceId, bytes });
    if (!response.ok) throw toError(response.error);
    if (response.kind === 'open' || response.kind === 'wrap-amk') {
      throw new Error(
        `EnvelopeCrypto: unexpected response kind "${response.kind}" for sealBytes()`,
      );
    }
    return response.wire;
  }

  async wrapAmkForEscrow(recoveryCode: string): Promise<WrappedAmkBlob> {
    const response = await this.send({ type: 'wrap-amk', recoveryCode });
    if (!response.ok) throw toError(response.error);
    if (response.kind !== 'wrap-amk') {
      throw new Error(
        `EnvelopeCrypto: unexpected response kind "${response.kind}" for wrapAmkForEscrow()`,
      );
    }
    return response.blob;
  }
}

/**
 * The production path: every request crosses `postMessage` to a real
 * (same-origin, bundled) `Worker`. The AMK is copied once into a dedicated
 * buffer and THAT buffer is transferred (not the caller's own
 * `options.amk`, which the caller may still hold/reuse elsewhere) — after
 * this constructor returns, the transferred buffer is detached and no
 * longer readable from the main thread; the worker is the sole holder of
 * the raw AMK from this point on.
 */
class WorkerEnvelopeCrypto extends EnvelopeCryptoClientBase {
  private readonly worker: WorkerLike;

  constructor(worker: WorkerLike, amk: Uint8Array, accountId: string) {
    super();
    this.worker = worker;
    this.worker.onmessage = (event) => this.resolve(event.data as EnvelopeResponse);
    const amkForTransfer = new Uint8Array(amk);
    const init: EnvelopeInitMessage = { type: 'init', amk: amkForTransfer, accountId };
    this.worker.postMessage(init, [amkForTransfer.buffer]);
  }

  protected dispatch(request: EnvelopeRequest): void {
    this.worker.postMessage(request);
  }

  dispose(): void {
    this.worker.terminate?.();
  }
}

/**
 * The Node/vitest fallback: no `Worker` global exists (confirmed empirically
 * against this repo's `vite@8.1.5` + `vitest@3.2.7`: `?worker`'s generated
 * factory only references `Worker` inside its body, so importing it is
 * safe, but *calling* it is not). Routes through the exact same
 * {@link MicrotaskBatcher} + `EnvelopeCryptoEngine.handleBatch` combination
 * `crypto-worker.ts` uses, just without the `postMessage` hop — so its
 * batching/ordering/error-shape behavior is identical to the real worker
 * path, not a second implementation. There is no real "main thread" to
 * protect here (a Node test process has no UI to block), which is why this
 * fallback is allowed to run the engine in-process at all.
 */
class InlineEnvelopeCrypto extends EnvelopeCryptoClientBase {
  private readonly batcher: MicrotaskBatcher<EnvelopeRequest, EnvelopeResponse>;

  constructor(amk: Uint8Array, accountId: string) {
    super();
    const engine = new EnvelopeCryptoEngine(amk, accountId);
    this.batcher = new MicrotaskBatcher<EnvelopeRequest, EnvelopeResponse>(
      (batch) => engine.handleBatch(batch),
      (result) => this.resolve(result),
    );
  }

  protected dispatch(request: EnvelopeRequest): void {
    this.batcher.push(request);
  }

  dispose(): void {}
}

/**
 * Picks the worker-backed implementation whenever a `Worker` global exists
 * (every real browser and Electron's renderer — see `AGENTS.md`'s note that
 * the desktop shell loads the same PWA build over http(s), a normal
 * same-origin Chromium context) and falls back to the inline one otherwise
 * (Node/vitest's default `environment: 'node'`, which `relay-client.test.ts`
 * uses for ~90 real `RelayClient` instances with no per-test wiring needed).
 */
export function createEnvelopeCrypto(amk: Uint8Array, accountId: string): EnvelopeCrypto {
  if (typeof Worker !== 'undefined') {
    return new WorkerEnvelopeCrypto(new CryptoWorker(), amk, accountId);
  }
  return new InlineEnvelopeCrypto(amk, accountId);
}
