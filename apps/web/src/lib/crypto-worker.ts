/// <reference lib="webworker" />
import { EnvelopeCryptoEngine } from './crypto-worker-engine';
import { MicrotaskBatcher } from './microtask-batcher';
import type {
  EnvelopeInitMessage,
  EnvelopeRequest,
  EnvelopeResponse,
} from './crypto-worker-protocol';

/**
 * The bundled envelope-crypto worker (issue #756, SPEC §8). Loaded ONLY via
 * `envelope-crypto-client.ts`'s static `import CryptoWorker from
 * './crypto-worker?worker'` — Vite's `?worker` suffix requires a literal
 * import specifier to discover and bundle a same-origin, hashed worker chunk
 * at build time (verified against this exact repo's `vite@8.1.5`: the
 * transform compiles the import into a plain factory function calling
 * `new Worker("/assets/crypto-worker-<hash>.js", ...)`, never a
 * runtime-constructed URL). `crypto-worker-load-path.test.ts` asserts that
 * specifier stays a literal — swapping it for a computed/dynamic URL would
 * stop Vite from ever emitting that chunk.
 *
 * The one `init` message hands over the account's AMK (transferred, not
 * copied — see `envelope-crypto-client.ts`'s `WorkerEnvelopeCrypto`
 * constructor) and every `open`/`seal`/`wrap-amk` request after that is
 * served from here: this worker context is now the only place
 * `crypto.subtle` runs for session traffic (`crypto-worker-engine.ts`'s
 * `EnvelopeCryptoEngine`).
 *
 * Batching: every request is pushed onto a {@link MicrotaskBatcher} rather
 * than decrypted immediately, so whatever arrives before the next microtask
 * flush goes through one `EnvelopeCryptoEngine.handleBatch` call — the
 * `Promise.all` E3-4 asked for, scoped to this worker's own message handler.
 */
let engine: EnvelopeCryptoEngine | undefined;

const batcher = new MicrotaskBatcher<EnvelopeRequest, EnvelopeResponse>(
  (batch) => {
    if (!engine) {
      throw new Error('crypto-worker: request received before init');
    }
    return engine.handleBatch(batch);
  },
  (result) => self.postMessage(result),
);

self.onmessage = (event: MessageEvent<EnvelopeInitMessage | EnvelopeRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    engine = new EnvelopeCryptoEngine(message.amk, message.accountId);
    return;
  }
  batcher.push(message);
};
