import { PROTOCOL_V1 } from '@loombox/protocol';
import type { TerminalOutput, TerminalResyncMarker } from '@loombox/protocol';

/**
 * Bounded output queue for one open terminal's `terminal_output` fan-out
 * (SPEC §7.16; issue #207) — the terminal-stream sibling of `outbox.ts`'s
 * `BoundedClientOutbox`, which this class deliberately mirrors
 * structurally (same single-flight pump, same `minFlushIntervalMs` floor,
 * same drop-oldest-then-mark shape) rather than sharing code with it: the
 * two differ in what a "drop" means enough to be worth keeping apart —
 * `session_update`'s marker groups a run of drops by `sessionId` alone,
 * this one groups every dropped item by `sessionId` + `terminalId`
 * regardless of position in the dropped batch (not just contiguous runs —
 * see {@link buildMarkers}'s own doc comment for why that distinction
 * matters even though `relay.ts` gives every terminal its own instance
 * today: a caller that reused one instance across terminals, or a future
 * change that goes back to sharing one, must not silently reintroduce the
 * unbounded-growth bug this grouping was written to fix).
 *
 * `relay.ts` creates one `BoundedTerminalOutbox` PER OPEN TERMINAL per
 * client connection (`terminalOutboxFor`, keyed by `sessionId:terminalId`),
 * not one shared instance for the whole connection like `outbox`/
 * `BoundedClientOutbox` above: SPEC §7.5/issue #173 lets one session hold
 * several open terminals sharing a connection, and a single shared queue
 * was tried first and found, with a real two-terminal round trip, to let
 * one terminal's firehose (a busy build log) evict — and so starve, not
 * just delay — a second, otherwise-idle terminal's own reply for as long
 * as the first kept overflowing. One small bounded queue per terminal
 * means the total in-flight bound scales with the number of terminals a
 * user actually has open (small, user-controlled) rather than with
 * output volume, and structurally cannot let one terminal starve another.
 *
 * There is no terminal analogue of `resync_request`/the relay's
 * `session_update` ring buffer: a dropped PTY chunk was never durably
 * persisted anywhere to replay from, so once `terminal_resync_marker`
 * reports a gap, that stretch of output is gone for good — the marker
 * exists only so the client can say so visibly instead of rendering a
 * silently truncated stream as if it were complete.
 */

export type TerminalOutboxItem = TerminalOutput | TerminalResyncMarker;

function makeMarker(
  sessionId: string,
  terminalId: string,
  fromSeq: number,
  toSeq: number,
): TerminalResyncMarker {
  return {
    type: 'terminal_resync_marker',
    protocolVersion: PROTOCOL_V1,
    sessionId,
    terminalId,
    fromSeq,
    toSeq,
    dropped: true,
  };
}

/**
 * Groups every dropped item into one marker per distinct (sessionId,
 * terminalId) pair, across the WHOLE dropped batch — not just contiguous
 * runs (issue #207's own hardening: a first cut of this function mirrored
 * `outbox.ts`'s `buildMarkers` literally, grouping contiguous entries
 * only, which is exactly right when one connection ever drops for one
 * session at a time. It fails badly here: SPEC §7.5 lets one session hold
 * several open terminals sharing a connection, and interleaved output from
 * two live terminals (`term-a`, `term-b`, `term-a`, `term-b`, ...) means
 * almost no two adjacent dropped entries share a key, so "contiguous"
 * grouping produces almost as many markers as items dropped — the queue
 * barely shrinks on overflow, and a proven repro shows depth climbing
 * without bound across a sustained two-terminal burst instead of
 * converging on `maxDepth`). Grouping by key regardless of position
 * bounds the marker count by the number of DISTINCT terminals actively
 * bursting on this connection — small and burst-size-independent — which
 * is what actually keeps {@link BoundedTerminalOutbox.depth} bounded.
 *
 * An item being dropped here can itself already be a `terminal_resync_marker`
 * from an earlier overflow in the same burst (the drain never got a chance
 * to flush it before the queue overflowed again) — its own `fromSeq`/
 * `toSeq` fold into the same running min/max rather than losing the
 * earlier, wider range it already covered.
 */
function buildMarkers(dropped: readonly TerminalOutboxItem[]): TerminalResyncMarker[] {
  const ranges = new Map<
    string,
    { sessionId: string; terminalId: string; fromSeq: number; toSeq: number }
  >();
  for (const item of dropped) {
    const key = `${item.sessionId}:${item.terminalId}`;
    const from = item.type === 'terminal_output' ? item.seq : item.fromSeq;
    const to = item.type === 'terminal_output' ? item.seq : item.toSeq;
    const existing = ranges.get(key);
    if (existing) {
      existing.fromSeq = Math.min(existing.fromSeq, from);
      existing.toSeq = Math.max(existing.toSeq, to);
    } else {
      // `Map` iterates in insertion order, so this doubles as the marker
      // output order — no separate index needed.
      ranges.set(key, { sessionId: item.sessionId, terminalId: item.terminalId, fromSeq: from, toSeq: to });
    }
  }
  return [...ranges.values()].map((range) =>
    makeMarker(range.sessionId, range.terminalId, range.fromSeq, range.toSeq),
  );
}

const DEFAULT_MIN_FLUSH_INTERVAL_MS = 0;

export class BoundedTerminalOutbox {
  private readonly queue: TerminalOutboxItem[] = [];
  private sending = false;

  constructor(
    private readonly send: (item: TerminalOutboxItem, done: () => void) => void,
    private readonly maxDepth: number,
    private readonly minFlushIntervalMs: number = DEFAULT_MIN_FLUSH_INTERVAL_MS,
  ) {}

  /** Current queued (not-yet-sent) depth — exposed for tests/observability, not routing logic; the hard numeric proof that this queue never grows past `maxDepth`. */
  get depth(): number {
    return this.queue.length;
  }

  enqueue(item: TerminalOutboxItem): void {
    this.queue.push(item);
    if (this.queue.length > this.maxDepth) {
      const dropped: TerminalOutboxItem[] = [];
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
