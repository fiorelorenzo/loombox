/**
 * Coalesces same-tick calls into one batched `flush` (issue #756's "envelopes
 * arriving in the same tick decrypt in one `Promise.all`"). The first
 * {@link push} after an idle queue schedules a microtask; every further
 * `push` before that microtask actually runs joins the same batch — this is
 * what "same tick" means here: whatever accumulated by the time the
 * JavaScript job queue drains down to microtasks.
 *
 * `flush` receives the accumulated `Req[]` exactly once, in push order, and
 * must resolve with one `Res` per request in that SAME order — this class
 * only decides *when* to flush, never re-orders `flush`'s own result. In
 * both real callers (`crypto-worker.ts`'s worker glue and
 * `envelope-crypto-client.ts`'s in-process fallback), `flush` is
 * `EnvelopeCryptoEngine.handleBatch`, which wraps the batch in a single
 * `Promise.all` — `Promise.all`'s own order-preserving contract is what
 * actually keeps requests and results paired correctly regardless of which
 * one's `crypto.subtle` call finishes first.
 */
export class MicrotaskBatcher<Req, Res> {
  private pending: Req[] = [];
  private scheduled = false;

  constructor(
    private readonly flush: (batch: readonly Req[]) => Promise<readonly Res[]>,
    private readonly deliver: (result: Res, request: Req) => void,
  ) {}

  push(request: Req): void {
    this.pending.push(request);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.runFlush());
  }

  private runFlush(): void {
    this.scheduled = false;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;
    void this.flush(batch).then((results) => {
      results.forEach((result, index) => this.deliver(result, batch[index]));
    });
  }
}
