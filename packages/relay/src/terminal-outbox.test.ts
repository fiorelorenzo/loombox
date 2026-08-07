import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_V1 } from '@loombox/protocol';
import type { TerminalOutput } from '@loombox/protocol';
import { BoundedTerminalOutbox, type TerminalOutboxItem } from './terminal-outbox';

/**
 * Pure, deterministic unit coverage for {@link BoundedTerminalOutbox} — no
 * sockets, no relay: `enqueue`'s drop-oldest branch and the `depth` getter
 * are both synchronous, so the bound and drop semantics are provable with
 * plain function calls. Draining (the `minFlushIntervalMs`-paced pump)
 * genuinely needs time to pass, which fake timers drive deterministically
 * (`vi.runAllTimersAsync`) rather than a real wall-clock wait.
 * `relay.test.ts`'s "terminal_output bounded fan-out backpressure" suite
 * covers this same class wired into a real relay/WebSocket round trip; this
 * file is the narrower, faster proof of the queue data structure itself
 * (issue #207, SPEC §7.16).
 */

function chunk(terminalId: string, seq: number): TerminalOutput {
  return {
    type: 'terminal_output',
    protocolVersion: PROTOCOL_V1,
    sessionId: 'sess-1',
    terminalId,
    seq,
    envelope: { resourceId: 'sess-1', iv: 'AAAA', ciphertext: 'AAAA', alg: 'AES-256-GCM' },
  };
}

/** A `BoundedTerminalOutbox` whose `send` callback never fires `done` — freezes the pump after its very first (immediately synchronous) send, so every later `enqueue` call is provably still exercising the `queue`/`depth` bound rather than being silently drained out from under the test. */
function frozenOutbox(maxDepth: number): BoundedTerminalOutbox {
  return new BoundedTerminalOutbox(() => {
    // `done` deliberately never called.
  }, maxDepth);
}

describe('BoundedTerminalOutbox (SPEC §7.16; issue #207) — synchronous bound/drop semantics', () => {
  it('never lets depth grow past a small constant, with hard numbers, across a burst far larger than the bound (one terminal)', () => {
    const maxDepth = 8;
    const outbox = frozenOutbox(maxDepth);

    let peakDepth = 0;
    const burstSize = 500;
    for (let i = 1; i <= burstSize; i++) {
      outbox.enqueue(chunk('term-1', i));
      peakDepth = Math.max(peakDepth, outbox.depth);
    }

    // The queue's own drop-then-unshift-a-marker step can leave it one item
    // over `maxDepth` right after an overflow (the marker occupies a slot
    // too) — `maxDepth + 1` is the real, verified ceiling for one terminal,
    // not `maxDepth` itself. What matters for "does not unbound memory" is
    // that a 500-chunk burst against an 8-deep bound never grows past that
    // small constant, regardless of how large the burst gets.
    expect(peakDepth).toBeLessThanOrEqual(maxDepth + 1);
    expect(outbox.depth).toBeLessThanOrEqual(maxDepth + 1);
  });

  it('stays bounded — and does not creep upward over a sustained burst — when several terminals interleave on one connection (regression: a first cut of buildMarkers only coalesced CONTIGUOUS same-terminal drops, so alternating output from two terminals produced almost as many markers as items dropped and depth grew without bound)', () => {
    const maxDepth = 8;
    const outbox = frozenOutbox(maxDepth);
    const terminals = ['term-a', 'term-b', 'term-c'];

    for (let i = 1; i <= 2000; i++) {
      for (const terminalId of terminals) outbox.enqueue(chunk(terminalId, i));
    }
    const depthAfter2000 = outbox.depth;

    for (let i = 2001; i <= 20000; i++) {
      for (const terminalId of terminals) outbox.enqueue(chunk(terminalId, i));
    }
    const depthAfter20000 = outbox.depth;

    // Bounded by a small constant (maxDepth plus at most one marker per
    // distinct terminal) …
    expect(depthAfter2000).toBeLessThanOrEqual(maxDepth + terminals.length);
    expect(depthAfter20000).toBeLessThanOrEqual(maxDepth + terminals.length);
    // … and, critically, identical after 10x the volume: real proof the
    // bound holds over sustained load, not just at one sample point.
    expect(depthAfter20000).toBe(depthAfter2000);
  });

  it('drops the oldest entries once maxDepth is exceeded', () => {
    const maxDepth = 3;
    const outbox = frozenOutbox(maxDepth);

    // The very first enqueue starts the (frozen) pump and is sent
    // immediately, so it never occupies queue depth; every enqueue after
    // that queues for real, hitting the same `maxDepth + 1` ceiling the
    // first test above verifies.
    for (let i = 1; i <= 10; i++) outbox.enqueue(chunk('term-1', i));

    expect(outbox.depth).toBe(maxDepth + 1);
  });
});

describe('BoundedTerminalOutbox (SPEC §7.16; issue #207) — draining, with fake timers driving the real minFlushIntervalMs floor deterministically', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('folds a dropped run into a marker with the correct fromSeq/toSeq and dropped: true, then delivers the surviving tail in order', async () => {
    const maxDepth = 2;
    const delivered: TerminalOutboxItem[] = [];
    const draining = new BoundedTerminalOutbox(
      (item, done) => {
        delivered.push(item);
        done();
      },
      maxDepth,
      1, // minFlushIntervalMs — small and explicit, driven by fake timers below
    );

    for (let i = 1; i <= 20; i++) draining.enqueue(chunk('term-1', i));
    await vi.runAllTimersAsync();

    const markers = delivered.filter((item) => item.type === 'terminal_resync_marker');
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(marker.dropped).toBe(true);
      expect(marker.terminalId).toBe('term-1');
      expect(marker.fromSeq).toBeLessThanOrEqual(marker.toSeq);
    }
    // The last chunk enqueued (seq 20) is never itself evicted — nothing
    // was ever enqueued after it — so it survives to delivery, last.
    const survivingChunks = delivered.filter(
      (item): item is TerminalOutput => item.type === 'terminal_output',
    );
    expect(survivingChunks.at(-1)?.seq).toBe(20);
    // Delivery order is exactly queue order: whatever markers/chunks
    // remained, in seq/drop order, never reshuffled.
    for (let i = 1; i < delivered.length; i++) {
      const prev = delivered[i - 1];
      const cur = delivered[i];
      const prevTo = prev.type === 'terminal_output' ? prev.seq : prev.toSeq;
      const curFrom = cur.type === 'terminal_output' ? cur.seq : cur.fromSeq;
      expect(curFrom).toBeGreaterThan(prevTo);
    }
  });

  it('groups drops per (sessionId, terminalId), never mixing two terminals into the same marker, even fully interleaved', async () => {
    const maxDepth = 1;
    const delivered: TerminalOutboxItem[] = [];
    const draining = new BoundedTerminalOutbox(
      (item, done) => {
        delivered.push(item);
        done();
      },
      maxDepth,
      1,
    );

    for (let i = 1; i <= 10; i++) {
      draining.enqueue(chunk('term-a', i));
      draining.enqueue(chunk('term-b', i));
    }
    await vi.runAllTimersAsync();

    const markers = delivered.filter((item) => item.type === 'terminal_resync_marker');
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(['term-a', 'term-b']).toContain(marker.terminalId);
    }
  });
});
