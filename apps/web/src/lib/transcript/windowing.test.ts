import { describe, expect, it } from 'vitest';
import {
  isCompactToolRow,
  TRANSCRIPT_COMPACT_GAP_PX,
  TRANSCRIPT_OVERSCAN_ITEMS,
  TRANSCRIPT_ROW_ESTIMATE_PX,
  TRANSCRIPT_ROW_GAP_PX,
  TranscriptWindow,
  type TranscriptWindowItem,
} from './windowing.svelte';

function toolCalls(count: number, prefix = 't'): TranscriptWindowItem[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, type: 'tool_call' }));
}

describe('isCompactToolRow (issue #668 rhythm, shared with the offsets engine below)', () => {
  it('is true only for a tool_call directly following another tool_call', () => {
    const items: TranscriptWindowItem[] = [
      { id: 'a', type: 'tool_call' },
      { id: 'b', type: 'tool_call' },
      { id: 'c', type: 'message' },
      { id: 'd', type: 'tool_call' },
    ];
    expect(isCompactToolRow(items, 0)).toBe(false); // no predecessor
    expect(isCompactToolRow(items, 1)).toBe(true); // tool_call after tool_call
    expect(isCompactToolRow(items, 2)).toBe(false); // message
    expect(isCompactToolRow(items, 3)).toBe(false); // tool_call after message
  });
});

describe('TranscriptWindow.range: mounts a bounded slice, not the whole transcript', () => {
  it('a 2000-item transcript keeps only the visible span plus overscan in range, not all 2000', () => {
    const win = new TranscriptWindow();
    win.items = toolCalls(2000);
    win.pinToTail = false;
    win.scrollTop = 5000;
    win.viewportPx = 600;

    const { range } = win;
    const mounted = range.end - range.start + 1;
    expect(mounted).toBeLessThan(60);
    expect(mounted).toBeLessThan(win.items.length);
    // A real window, not degenerate to nothing.
    expect(mounted).toBeGreaterThan(0);
  });

  it('growing the viewport mounts more rows, shrinking it mounts fewer', () => {
    const win = new TranscriptWindow();
    win.items = toolCalls(2000);
    win.pinToTail = false;
    win.scrollTop = 5000;

    win.viewportPx = 300;
    const small = win.range.end - win.range.start + 1;

    win.viewportPx = 3000;
    const large = win.range.end - win.range.start + 1;

    expect(large).toBeGreaterThan(small);
  });

  it('scrolling through history moves the window; it does not stay pinned to the same rows', () => {
    const win = new TranscriptWindow();
    win.items = toolCalls(2000);
    win.pinToTail = false;
    win.viewportPx = 600;

    win.scrollTop = 0;
    const atTop = win.range;
    win.scrollTop = 50_000;
    const inMiddle = win.range;

    expect(inMiddle.start).toBeGreaterThan(atTop.end);
  });

  it('an empty transcript renders nothing', () => {
    const win = new TranscriptWindow();
    win.items = [];
    expect(win.range).toEqual({ start: -1, end: -1, leadPx: 0, tailPx: 0 });
  });
});

describe('TranscriptWindow.range: pinToTail (issue #755 follow-mode contract)', () => {
  it('always ends on the very last item, regardless of scrollTop', () => {
    const win = new TranscriptWindow();
    win.items = toolCalls(2000);
    win.pinToTail = true;
    win.scrollTop = 0; // stale/irrelevant while pinned
    win.viewportPx = 600;

    expect(win.range.end).toBe(1999);
  });

  it('still mounts a small bounded window from the tail, not the whole 2000-item history', () => {
    const win = new TranscriptWindow();
    win.items = toolCalls(2000);
    win.pinToTail = true;
    win.viewportPx = 600;

    const mounted = win.range.end - win.range.start + 1;
    expect(mounted).toBeLessThan(60);
  });

  it('mounts a bounded window from the tail even before the container has ever reported a real viewport height (fresh mount of a long session)', () => {
    const win = new TranscriptWindow();
    win.items = toolCalls(2000);
    win.pinToTail = true;
    // viewportPx defaults to 0 here — no ResizeObserver has fired yet.

    const mounted = win.range.end - win.range.start + 1;
    expect(win.range.end).toBe(1999);
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(60);
  });

  it('a streaming turn is always inside the mounted range, never left as an estimate behind the tail spacer', () => {
    const win = new TranscriptWindow();
    win.items = toolCalls(50);
    win.pinToTail = true;
    win.viewportPx = 400;

    // Simulate the item currently streaming: it grows in place (same id,
    // same index — the reducer's append-by-id contract), and each growth
    // is reported the same way a real row's ResizeObserver would.
    win.recordHeight('t49', 24);
    expect(win.range.end).toBe(49);
    win.recordHeight('t49', 220);
    expect(win.range.end).toBe(49);
  });
});

describe('TranscriptWindow: measured heights feed the offsets engine', () => {
  it('ignores a non-positive measurement instead of corrupting the height map with it', () => {
    const win = new TranscriptWindow();
    win.items = toolCalls(3);
    win.pinToTail = false;
    win.viewportPx = 1000;
    const before = win.range.leadPx;

    win.recordHeight('t0', 0);
    win.recordHeight('t0', -5);

    expect(win.range.leadPx).toBe(before);
  });

  it("a measured row's real height changes total px away from the flat estimate", () => {
    const win = new TranscriptWindow();
    win.items = toolCalls(5);
    win.pinToTail = false;
    win.viewportPx = 1000;

    const estimatedTotal = win.totalPx;
    win.recordHeight('t2', 400); // a diff-sized row, far from the 56px estimate
    expect(win.totalPx).toBe(estimatedTotal + (400 - TRANSCRIPT_ROW_ESTIMATE_PX));
  });

  it('the compact tool-call rhythm (2px) applies between consecutive tool_call rows instead of the base 8px gap', () => {
    const win = new TranscriptWindow();
    win.items = [
      { id: 'a', type: 'tool_call' },
      { id: 'b', type: 'tool_call' }, // compact against 'a'
      { id: 'c', type: 'message' }, // base gap against 'b'
    ];
    win.pinToTail = false;
    win.viewportPx = 1000;
    win.scrollTop = 0;

    // Nothing measured: every row is the same TRANSCRIPT_ROW_ESTIMATE_PX,
    // so the gap between item[end]'s bottom edge and the total is exactly
    // the sum of the two boundary gaps.
    const perRow = TRANSCRIPT_ROW_ESTIMATE_PX;
    expect(win.totalPx).toBe(perRow * 3 + TRANSCRIPT_COMPACT_GAP_PX + TRANSCRIPT_ROW_GAP_PX);
  });

  it('active anchoring: a row above the rendered window trading its estimate for a real height moves leadPx by exactly that delta', () => {
    const win = new TranscriptWindow();
    win.items = toolCalls(200);
    win.pinToTail = false;
    win.scrollTop = 50_000; // scrolled into the middle of history
    win.viewportPx = 600;

    const startIndex = win.range.start;
    expect(startIndex).toBeGreaterThan(TRANSCRIPT_OVERSCAN_ITEMS); // there is real history above the window
    const aboveWindowId = win.items[0]!.id; // well before `start`, never mounted yet

    const leadBefore = win.range.leadPx;
    win.recordHeight(aboveWindowId, 300); // it just scrolled into view once, upstream, and got measured
    const leadAfter = win.range.leadPx;

    expect(leadAfter - leadBefore).toBe(300 - TRANSCRIPT_ROW_ESTIMATE_PX);
    // `TranscriptTimeline`'s pin effect reads exactly this delta and adds
    // it to the real `scrollTop` so the reader's current view doesn't
    // jump — see that component's own test for the DOM-level proof.
  });

  it('reset() drops every measured height (a session switch is a different transcript)', () => {
    const win = new TranscriptWindow();
    // Plain message rows, deliberately not tool_call: this test is about
    // the height cache, and tool_call's own compact-gap rule (covered
    // above) would otherwise change the expected total independently.
    win.items = [
      { id: 'm0', type: 'message' },
      { id: 'm1', type: 'message' },
      { id: 'm2', type: 'message' },
    ];
    win.pinToTail = false;
    win.viewportPx = 1000;
    win.recordHeight('m0', 400);
    expect(win.totalPx).not.toBe(TRANSCRIPT_ROW_ESTIMATE_PX * 3 + TRANSCRIPT_ROW_GAP_PX * 2);

    win.reset();
    expect(win.totalPx).toBe(TRANSCRIPT_ROW_ESTIMATE_PX * 3 + TRANSCRIPT_ROW_GAP_PX * 2);
  });
});
