import { generateAmk } from '@loombox/crypto';
import type { EncryptedEnvelope } from '@loombox/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvelopeCryptoEngine } from './crypto-worker-engine';
import type { EnvelopeInitMessage, EnvelopeRequest } from './crypto-worker-protocol';
import {
  createEnvelopeCrypto,
  type EnvelopeCrypto,
  type WorkerLike,
} from './envelope-crypto-client';

/**
 * Stands in for a real DOM `Worker`, backed by a real {@link EnvelopeCryptoEngine}
 * "on the other side" — every `postMessage` this fake receives is handled
 * exactly like `crypto-worker.ts` would (one request per message, an `init`
 * message constructs the engine), so these tests exercise real crypto
 * through the real `WorkerEnvelopeCrypto` request/response plumbing, just
 * without an actual OS thread. `sent`/`transfers` record every message this
 * fake worker received, in order.
 *
 * Constructed the same shape `new Worker(url, options)` is (Vite's `?worker`
 * factory calls exactly that) so stubbing the global `Worker` constructor
 * with this class exercises `createEnvelopeCrypto`'s REAL worker branch —
 * including the unexported `WorkerEnvelopeCrypto` class — through nothing
 * but the public `createEnvelopeCrypto`/`EnvelopeCrypto` surface.
 */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: (EnvelopeInitMessage | EnvelopeRequest)[] = [];
  readonly transfers: (readonly Transferable[] | undefined)[] = [];
  terminated = false;
  private engine: EnvelopeCryptoEngine | undefined;

  postMessage(message: unknown, transfer?: readonly Transferable[]): void {
    const data = message as EnvelopeInitMessage | EnvelopeRequest;
    this.sent.push(data);
    this.transfers.push(transfer);
    if (data.type === 'init') {
      this.engine = new EnvelopeCryptoEngine(data.amk, data.accountId);
      return;
    }
    if (!this.engine) throw new Error('FakeWorker: request received before init');
    void this.engine.handleBatch([data]).then(([result]) => {
      this.onmessage?.({ data: result } as MessageEvent);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** `Worker` is a DOM global `createEnvelopeCrypto` merely checks `typeof` on and constructs via the separately-imported `?worker` factory — stubbing it for these tests is test-only global manipulation, not a cast over untrusted external data, so one named, documented cast here stands in for the whole file instead of repeating an inline one per call site. */
const globalWithWorker = globalThis as Omit<typeof globalThis, 'Worker'> & { Worker: unknown };

function stubGlobalWorker(ctor: new (...args: never[]) => WorkerLike): void {
  globalWithWorker.Worker = ctor;
}

const originalWorker = globalWithWorker.Worker;

afterEach(() => {
  globalWithWorker.Worker = originalWorker;
});

describe('createEnvelopeCrypto (issue #756)', () => {
  it('picks the worker-backed path when a `Worker` global exists', async () => {
    stubGlobalWorker(FakeWorker);
    const crypto = createEnvelopeCrypto(generateAmk(), 'acct-1');
    const wire = await crypto.seal('session', 'sess-1', 'sess-1', { text: 'via worker' });
    const opened = await crypto.open<{ text: string }>('session', 'sess-1', 'sess-1', wire);
    expect(opened).toEqual({ text: 'via worker' });
  });

  it("falls back to the in-process path with no `Worker` global (this repo's vitest default) and still round-trips correctly", async () => {
    globalWithWorker.Worker = undefined;
    expect(typeof globalWithWorker.Worker).toBe('undefined');
    const crypto = createEnvelopeCrypto(generateAmk(), 'acct-1');
    const wire = await crypto.seal('project', 'proj-1', 'proj-1', { text: 'inline' });
    const opened = await crypto.open<{ text: string }>('project', 'proj-1', 'proj-1', wire);
    expect(opened).toEqual({ text: 'inline' });
  });
});

describe('WorkerEnvelopeCrypto (issue #756, via createEnvelopeCrypto + a stubbed global Worker)', () => {
  function stubCapturingWorker(): { instances: FakeWorker[] } {
    const instances: FakeWorker[] = [];
    class CapturingFakeWorker extends FakeWorker {
      constructor() {
        super();
        instances.push(this);
      }
    }
    stubGlobalWorker(CapturingFakeWorker);
    return { instances };
  }

  it('transfers a COPY of the AMK, not the caller-owned buffer — the original stays fully readable', () => {
    const { instances } = stubCapturingWorker();
    const amk = generateAmk();
    const amkSnapshot = new Uint8Array(amk); // independent copy to assert against after the fact
    createEnvelopeCrypto(amk, 'acct-1');

    expect(instances).toHaveLength(1);
    const init = instances[0].sent[0] as EnvelopeInitMessage;
    expect(init.type).toBe('init');
    expect(init.amk).toEqual(amkSnapshot); // same bytes...
    expect(init.amk).not.toBe(amk); // ...but a different Uint8Array than the caller's own
    expect(instances[0].transfers[0]).toEqual([init.amk.buffer]); // and the COPY's buffer was transferred

    // The caller's original array is untouched — proves RelayClient's own
    // `options.amk` (which a caller may still hold/reuse) was never itself
    // handed over/detached, only this dedicated copy was.
    expect(amk).toEqual(amkSnapshot);
  });

  it('correlates concurrent requests by requestId even when responses arrive out of request order', async () => {
    stubCapturingWorker();
    const amk = generateAmk();
    const crypto: EnvelopeCrypto = createEnvelopeCrypto(amk, 'acct-1');

    const sealed: EncryptedEnvelope[] = [];
    for (let i = 0; i < 3; i++) {
      sealed.push(await crypto.seal('session', 'sess-1', 'sess-1', { n: i }));
    }

    // Fire three opens "at once" (no await between them) — the FakeWorker
    // resolves each via its own `.then()`, and nothing here forces them to
    // settle in submission order, so a passing result proves correlation by
    // `requestId`, not by "whichever pending promise happened to be
    // resolved first".
    const [a, b, c] = await Promise.all([
      crypto.open<{ n: number }>('session', 'sess-1', 'sess-1', sealed[2]),
      crypto.open<{ n: number }>('session', 'sess-1', 'sess-1', sealed[0]),
      crypto.open<{ n: number }>('session', 'sess-1', 'sess-1', sealed[1]),
    ]);
    expect([a.n, b.n, c.n]).toEqual([2, 0, 1]);
  });

  it('a decrypt failure rejects the specific caller with a real Error, not swallowed at the worker boundary', async () => {
    stubCapturingWorker();
    const crypto = createEnvelopeCrypto(generateAmk(), 'acct-1');
    const corrupt: EncryptedEnvelope = {
      resourceId: 'sess-1',
      iv: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==',
      alg: 'AES-256-GCM',
    };
    await expect(crypto.open('session', 'sess-1', 'sess-1', corrupt)).rejects.toThrow();
  });

  it('dispose() terminates the underlying worker', () => {
    const { instances } = stubCapturingWorker();
    const crypto = createEnvelopeCrypto(generateAmk(), 'acct-1');
    crypto.dispose();
    expect(instances[0].terminated).toBe(true);
  });
});
