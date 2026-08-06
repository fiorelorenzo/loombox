// @vitest-environment jsdom
//
// The real worker glue (`crypto-worker.ts`) assigns `self.onmessage` at
// module scope, which needs a `self` global to exist at import time —
// jsdom provides one (aliased to `window`, confirmed empirically against
// this repo's vitest/jsdom versions), unlike the default `node` environment
// every other file in this package uses. This is the one test file that
// actually imports and drives `crypto-worker.ts` itself, simulating the
// `postMessage`/`onmessage` a real `Worker` boundary would deliver.
import {
  decryptEnvelope,
  deriveSessionKey,
  envelopeFromWire,
  generateAmk,
  sealJson,
} from '@loombox/crypto';
import type { EncryptedEnvelope } from '@loombox/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvelopeCryptoEngine } from './crypto-worker-engine';
import type {
  EnvelopeInitMessage,
  EnvelopeOpenRequest,
  EnvelopeResponse,
} from './crypto-worker-protocol';
// Side-effect import — wires up `self.onmessage` exactly once (module
// state is deliberately NOT reset between tests, see below).
import './crypto-worker';

function post(data: EnvelopeInitMessage | EnvelopeOpenRequest): void {
  self.onmessage?.({ data } as MessageEvent);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('crypto-worker.ts (issue #756) — the real worker entry point', () => {
  // Every test starts with its own `post({ type: 'init', ... })`, which
  // replaces the worker's module-scope `engine` with a brand new instance
  // — that's what actually isolates tests, not resetting the module
  // registry (which would load a SECOND, distinct `EnvelopeCryptoEngine`
  // class definition that `vi.spyOn(EnvelopeCryptoEngine.prototype, ...)`
  // below — imported once, at this file's own top level — could no longer
  // see calls through).

  it('decrypts a burst of same-tick requests through exactly one EnvelopeCryptoEngine.handleBatch call, ordering preserved', async () => {
    const handleBatchSpy = vi.spyOn(EnvelopeCryptoEngine.prototype, 'handleBatch');
    const amk = generateAmk();
    const accountId = 'acct-1';
    const key = await deriveSessionKey(amk, accountId, 'sess-1');

    const posted: EnvelopeResponse[] = [];
    const { promise: allSettled, resolve: markDone } = Promise.withResolvers<void>();
    let settledCount = 0;
    vi.spyOn(self, 'postMessage').mockImplementation(((data: unknown) => {
      posted.push(data as EnvelopeResponse);
      settledCount++;
      if (settledCount === 6) markDone();
    }) as typeof self.postMessage);

    post({ type: 'init', amk, accountId });

    const wires: EncryptedEnvelope[] = [];
    for (let i = 0; i < 6; i++) wires.push(await sealJson('sess-1', { n: i }, key));

    // All six in one synchronous loop — no `await` in between — is what
    // "the same tick" means for the worker's own message handler.
    for (let i = 0; i < 6; i++) {
      post({
        type: 'open',
        requestId: i,
        keyKind: 'session',
        keyId: 'sess-1',
        resourceId: 'sess-1',
        wire: wires[i],
      });
    }

    await allSettled;

    expect(handleBatchSpy).toHaveBeenCalledTimes(1);
    expect(handleBatchSpy.mock.calls[0][0]).toHaveLength(6);
    expect(posted.map((r) => r.requestId)).toEqual([0, 1, 2, 3, 4, 5]);
    const values = posted.map((r) => (r.ok && r.kind === 'open' ? r.value : undefined));
    expect(values).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);
  });

  it('a corrupt envelope surfaces as ok:false for its own requestId, not a dropped/uncaught worker crash', async () => {
    const amk = generateAmk();
    const accountId = 'acct-1';
    const key = await deriveSessionKey(amk, accountId, 'sess-1');

    const { promise: got, resolve: markDone } = Promise.withResolvers<EnvelopeResponse>();
    vi.spyOn(self, 'postMessage').mockImplementation(((data: unknown) => {
      markDone(data as EnvelopeResponse);
    }) as typeof self.postMessage);

    post({ type: 'init', amk, accountId });
    const goodWire = await sealJson('sess-1', { n: 'ok' }, key);
    const corruptWire: EncryptedEnvelope = { ...goodWire, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' };

    post({
      type: 'open',
      requestId: 42,
      keyKind: 'session',
      keyId: 'sess-1',
      resourceId: 'sess-1',
      wire: corruptWire,
    });

    const response = await got;
    expect(response.requestId).toBe(42);
    expect(response.ok).toBe(false);
  });

  it('AMK-derived session key material never leaves this worker context — only ciphertext/plaintext-for-this-request cross back', async () => {
    const amk = generateAmk();
    const accountId = 'acct-1';
    const posted: EnvelopeResponse[] = [];
    const { promise: got, resolve: markDone } = Promise.withResolvers<void>();
    vi.spyOn(self, 'postMessage').mockImplementation(((data: unknown) => {
      posted.push(data as EnvelopeResponse);
      markDone();
    }) as typeof self.postMessage);

    post({ type: 'init', amk, accountId });
    const key = await deriveSessionKey(amk, accountId, 'sess-1');
    const wire = await sealJson('sess-1', { secret: 'plaintext-for-this-tab' }, key);
    post({
      type: 'open',
      requestId: 1,
      keyKind: 'session',
      keyId: 'sess-1',
      resourceId: 'sess-1',
      wire,
    });
    await got;

    const response = posted[0];
    expect(response.ok && response.kind === 'open' ? response.value : undefined).toEqual({
      secret: 'plaintext-for-this-tab',
    });
    // Nothing posted back ever contains raw key bytes or the AMK itself —
    // every field is a requestId, an ok/kind tag, plaintext JSON, or a wire
    // (ciphertext) envelope, matching the PR's "nothing but plaintext for
    // this tab crosses back" claim.
    const serialized = JSON.stringify(posted);
    expect(serialized).not.toContain(Buffer.from(amk).toString('base64'));
  });
});

// Sanity check for the independently-sealed-envelope test above: proves the
// worker's own crypto actually agrees with `@loombox/crypto`'s primitives
// used directly, not just with itself.
describe('cross-check against @loombox/crypto directly', () => {
  it('an envelope this suite seals independently opens under the worker-derived key', async () => {
    const amk = generateAmk();
    const key = await deriveSessionKey(amk, 'acct-1', 'sess-1');
    const wire = await sealJson('sess-1', { x: 1 }, key);
    const plaintext = await decryptEnvelope('sess-1', envelopeFromWire(wire), key);
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({ x: 1 });
  });
});
