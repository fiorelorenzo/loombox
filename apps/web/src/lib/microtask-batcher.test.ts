import { describe, expect, it } from 'vitest';
import { MicrotaskBatcher } from './microtask-batcher';

describe('MicrotaskBatcher (issue #756)', () => {
  it('coalesces every push in the same tick into exactly one flush call, in push order', async () => {
    const flushCalls: number[][] = [];
    const delivered: Array<{ request: number; result: number }> = [];
    const { promise: allDelivered, resolve: markDone } = Promise.withResolvers<void>();
    const batcher = new MicrotaskBatcher<number, number>(
      async (batch) => {
        flushCalls.push([...batch]);
        return batch.map((n) => n * 10);
      },
      (result, request) => {
        delivered.push({ request, result });
        if (delivered.length === 10) markDone();
      },
    );

    // Ten pushes in a plain synchronous loop — no `await` between them — is
    // exactly what "arriving in the same tick" means: they all land before
    // the microtask this batcher schedules on the first push ever runs.
    for (let i = 0; i < 10; i++) batcher.push(i);

    expect(flushCalls).toHaveLength(0); // nothing flushed yet — still the same synchronous turn
    await allDelivered; // await the real signal, not a guessed number of microtask ticks

    expect(flushCalls).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]]); // one call, one batch, push order
    expect(delivered.map((d) => d.request)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(delivered.map((d) => d.result)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it("delivers results in the batch's own order even when flush resolves them out of internal order", async () => {
    const delivered: number[] = [];
    const { promise: allDelivered, resolve: markDone } = Promise.withResolvers<void>();
    const batcher = new MicrotaskBatcher<number, string>(
      async (batch) => {
        // Scrambles completion order via a different number of microtask
        // hops per item (deterministic, no real-time wait) — exactly what a
        // real `Promise.all(requests.map(decryptOne))` produces when
        // different envelopes take different amounts of actual wall time.
        // The returned array is still in `batch`'s own order, which is the
        // contract `MicrotaskBatcher` relies on for ordering, not
        // completion timing.
        return Promise.all(
          batch.map((item, index) => {
            let settled = Promise.resolve(item);
            const hops = (batch.length - index) % 3;
            for (let hop = 0; hop < hops; hop++) settled = settled.then((value) => value);
            return settled.then((value) => `${value}-done`);
          }),
        );
      },
      (result) => {
        delivered.push(Number(result.split('-')[0]));
        if (delivered.length === 5) markDone();
      },
    );

    for (let i = 0; i < 5; i++) batcher.push(i);
    await allDelivered;

    expect(delivered).toEqual([0, 1, 2, 3, 4]);
  });

  it('starts a fresh batch after a flush completes — a push after settling is not silently dropped or merged into the prior batch', async () => {
    const flushCalls: number[][] = [];
    const firstDone = Promise.withResolvers<void>();
    const secondDone = Promise.withResolvers<void>();
    let deliveryCount = 0;
    const batcher = new MicrotaskBatcher<number, number>(
      async (batch) => {
        flushCalls.push([...batch]);
        return batch;
      },
      () => {
        deliveryCount++;
        if (deliveryCount === 1) firstDone.resolve();
        if (deliveryCount === 2) secondDone.resolve();
      },
    );

    batcher.push(1);
    await firstDone.promise;

    batcher.push(2);
    await secondDone.promise;

    expect(flushCalls).toEqual([[1], [2]]);
  });
});
