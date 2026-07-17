import { PROTOCOL_V1 } from '@loombox/protocol';
import type { ResyncMarker, SessionUpdateEnvelopeV1 } from '@loombox/protocol';

/**
 * Bounded per-client output queue for `session_update` fan-out (SPEC §7.16;
 * issues #98/#254): "bounded per-client output queues with drop-oldest + a
 * resync marker on overflow, so a slow client never blocks faster clients."
 *
 * One `BoundedClientOutbox` per WS client connection. It is single-flight
 * (at most one `send` in flight at a time) so a burst of fan-out that arrives
 * faster than the client drains it queues up instead of overlapping sends;
 * once the queue exceeds `maxDepth` the oldest entries are dropped and
 * replaced with a `resync_marker` telling the client which `seq` range it
 * missed, grouped per session so a burst spanning multiple sessions never
 * mixes their seq ranges into one marker.
 *
 * The next item only flushes once BOTH the transport's own `send` callback
 * has fired (real backpressure: a genuinely slow socket write naturally
 * paces this down) AND a small `minFlushIntervalMs` floor has elapsed. The
 * floor exists because tiny frames on a healthy connection (loopback in
 * particular) can complete faster than a burst of enqueues arrives, which
 * would mean the queue never observably grows even though the whole point
 * of this class is to bound it — the floor guarantees the bound is real and
 * exercisable without depending on the peer actually being slow.
 */

export type OutboxItem = SessionUpdateEnvelopeV1 | ResyncMarker;

/** The seq range an item represents — a single point for a live update, or the range an earlier marker already covered. */
function rangeOf(item: OutboxItem): { from: number; to: number } {
  return item.type === 'session_update'
    ? { from: item.seq, to: item.seq }
    : { from: item.fromSeq, to: item.toSeq };
}

function makeMarker(sessionId: string, fromSeq: number, toSeq: number): ResyncMarker {
  return {
    type: 'resync_marker',
    protocolVersion: PROTOCOL_V1,
    sessionId,
    fromSeq,
    toSeq,
    dropped: true,
  };
}

/**
 * Groups a run of dropped items into one marker per contiguous session,
 * preserving order. An item being dropped here can itself already be a
 * `resync_marker` from an earlier overflow in the same burst (the drain
 * never got a chance to flush it before the queue overflowed again) — in
 * that case its own `fromSeq` is folded in rather than losing the earlier,
 * lower bound of what was dropped.
 */
function buildMarkers(dropped: readonly OutboxItem[]): ResyncMarker[] {
  const markers: ResyncMarker[] = [];
  let runStart = 0;
  for (let i = 1; i <= dropped.length; i++) {
    const atBoundary = i === dropped.length || dropped[i].sessionId !== dropped[runStart].sessionId;
    if (atBoundary) {
      const from = rangeOf(dropped[runStart]).from;
      const to = rangeOf(dropped[i - 1]).to;
      markers.push(makeMarker(dropped[runStart].sessionId, from, to));
      runStart = i;
    }
  }
  return markers;
}

const DEFAULT_MIN_FLUSH_INTERVAL_MS = 2;

export class BoundedClientOutbox {
  private readonly queue: OutboxItem[] = [];
  private sending = false;

  constructor(
    private readonly send: (item: OutboxItem, done: () => void) => void,
    private readonly maxDepth: number,
    private readonly minFlushIntervalMs: number = DEFAULT_MIN_FLUSH_INTERVAL_MS,
  ) {}

  /** Current queued (not-yet-sent) depth — exposed for tests/observability, not routing logic. */
  get depth(): number {
    return this.queue.length;
  }

  enqueue(item: OutboxItem): void {
    this.queue.push(item);
    if (this.queue.length > this.maxDepth) {
      const dropped: OutboxItem[] = [];
      while (this.queue.length > this.maxDepth) {
        const next = this.queue.shift();
        if (next) dropped.push(next);
      }
      this.queue.unshift(...buildMarkers(dropped));
    }
    this.pump();
  }

  private pump(): void {
    if (this.sending) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.sending = true;

    let callbackFired = false;
    let floorElapsed = false;
    const advanceIfReady = (): void => {
      if (!callbackFired || !floorElapsed) return;
      this.sending = false;
      this.pump();
    };

    this.send(next, () => {
      callbackFired = true;
      advanceIfReady();
    });
    setTimeout(() => {
      floorElapsed = true;
      advanceIfReady();
    }, this.minFlushIntervalMs);
  }
}
