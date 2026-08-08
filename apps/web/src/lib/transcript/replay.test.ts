import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptItem, TranscriptMessageItem } from '@loombox/providers-core/browser';
import { REPLAY_SPEEDS, SessionReplay } from './replay.svelte';

function messageItem(overrides: Partial<TranscriptMessageItem> = {}): TranscriptMessageItem {
  return {
    type: 'message',
    id: overrides.id ?? 'm1',
    kind: 'agent_message_chunk',
    turnId: 'turn:1',
    messageId: 'msg-1',
    text: 'hello',
    ...overrides,
  };
}

function toolCallItem(id: string, turnId = 'turn:1'): TranscriptItem {
  return {
    type: 'tool_call',
    id,
    turnId,
    title: 'Read file',
    toolKind: 'read',
    status: 'completed',
    diff: undefined,
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
  } as TranscriptItem;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionReplay (issue #265)', () => {
  it('starts with nothing revealed and grows the displayed prefix as positionMs advances', () => {
    const replay = new SessionReplay([toolCallItem('tc1'), toolCallItem('tc2')]);
    flushSync();
    expect(replay.displayItems).toEqual([]);

    replay.play();
    flushSync();
    // A non-text item appears whole the instant its own reveal window
    // starts — no partial state to wait on (see the class doc comment).
    // The playback timer only advances in TICK_MS (50ms) quanta, so this
    // has to clear at least one full tick to observe any movement.
    vi.advanceTimersByTime(60);
    flushSync();
    expect(replay.displayItems.map((item) => item.id)).toEqual(['tc1']);
  });

  it('reveals a message item character by character, proportional to elapsed time within its own duration', () => {
    const replay = new SessionReplay([messageItem({ text: 'a'.repeat(400) })]);
    replay.play();
    flushSync();

    // 400 chars / 40 chars-per-sec = 10s total duration at 1x; halfway
    // through should show roughly half the text, never the whole thing.
    vi.advanceTimersByTime(5000);
    flushSync();
    const midway = replay.displayItems[0] as TranscriptMessageItem;
    expect(midway.text.length).toBeGreaterThan(0);
    expect(midway.text.length).toBeLessThan(400);
    expect('a'.repeat(400).startsWith(midway.text)).toBe(true);

    vi.advanceTimersByTime(6000);
    flushSync();
    const done = replay.displayItems[0] as TranscriptMessageItem;
    expect(done.text).toBe('a'.repeat(400));
  });

  it('never reveals content out of order, and the revealed prefix only ever grows while playing', () => {
    const items = [
      toolCallItem('tc1'),
      messageItem({ id: 'm1', text: 'short' }),
      toolCallItem('tc3'),
    ];
    const replay = new SessionReplay(items);
    replay.play();

    const seenCounts: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      vi.advanceTimersByTime(100);
      flushSync();
      seenCounts.push(replay.displayItems.length);
      // ids seen so far must be an exact prefix of the source order
      const ids = replay.displayItems.map((item) => item.id);
      expect(ids).toEqual(items.map((item) => item.id).slice(0, ids.length));
    }
    for (let i = 1; i < seenCounts.length; i += 1) {
      expect(seenCounts[i]).toBeGreaterThanOrEqual(seenCounts[i - 1]!);
    }
  });

  it('pause stops advancing, and play resumes from exactly where it left off', () => {
    const replay = new SessionReplay([messageItem({ text: 'a'.repeat(400) })]);
    replay.play();
    vi.advanceTimersByTime(3000);
    flushSync();
    const positionAtPause = replay.positionMs;
    replay.pause();

    vi.advanceTimersByTime(3000);
    flushSync();
    expect(replay.positionMs).toBe(positionAtPause);
    expect(replay.playing).toBe(false);

    replay.play();
    vi.advanceTimersByTime(1000);
    flushSync();
    expect(replay.positionMs).toBeGreaterThan(positionAtPause);
  });

  it('a higher speed reveals proportionally faster', () => {
    const a = new SessionReplay([messageItem({ text: 'a'.repeat(400) })]);
    const b = new SessionReplay([messageItem({ text: 'a'.repeat(400) })]);
    expect(REPLAY_SPEEDS).toContain(4);
    b.setSpeed(4);
    a.play();
    b.play();

    vi.advanceTimersByTime(1000);
    flushSync();
    const aRevealed = (a.displayItems[0] as TranscriptMessageItem).text.length;
    const bRevealed = (b.displayItems[0] as TranscriptMessageItem).text.length;
    expect(bRevealed).toBeGreaterThan(aRevealed);
  });

  it('skipToEnd reveals every item in full and stops, without fabricating a duration', () => {
    const items = [
      toolCallItem('tc1'),
      messageItem({ id: 'm1', text: 'hello there' }),
      toolCallItem('tc3'),
    ];
    const replay = new SessionReplay(items);
    replay.play();
    vi.advanceTimersByTime(100);

    replay.skipToEnd();
    flushSync();
    expect(replay.playing).toBe(false);
    expect(replay.finished).toBe(true);
    expect(replay.displayItems).toEqual(items);
    expect(replay.positionMs).toBe(replay.totalDurationMs);
  });

  it('finishes and auto-pauses once every item is fully revealed, never looping silently', () => {
    const replay = new SessionReplay([toolCallItem('tc1')]);
    replay.play();
    vi.advanceTimersByTime(60_000);
    flushSync();
    expect(replay.finished).toBe(true);
    expect(replay.playing).toBe(false);
    expect(replay.displayItems.map((item) => item.id)).toEqual(['tc1']);
  });

  it('seekMs scrubs directly to a position and pauses, honestly reflecting the jump rather than silently catching up', () => {
    const items = [toolCallItem('tc1'), toolCallItem('tc2'), toolCallItem('tc3')];
    const replay = new SessionReplay(items);
    replay.play();

    replay.seekMs(replay.totalDurationMs);
    flushSync();
    expect(replay.playing).toBe(false);
    expect(replay.displayItems.map((item) => item.id)).toEqual(['tc1', 'tc2', 'tc3']);

    replay.seekMs(0);
    flushSync();
    expect(replay.displayItems).toEqual([]);
  });

  it('stepForward completes the in-progress item and stops exactly at the next item boundary', () => {
    const items = [messageItem({ id: 'm1', text: 'a'.repeat(400) }), toolCallItem('tc2')];
    const replay = new SessionReplay(items);
    replay.play();
    vi.advanceTimersByTime(2000); // partway through the first item
    flushSync();
    expect((replay.displayItems[0] as TranscriptMessageItem).text.length).toBeLessThan(400);

    replay.stepForward();
    flushSync();
    expect(replay.playing).toBe(false);
    expect(replay.displayItems.map((item) => item.id)).toEqual(['m1']);
    expect((replay.displayItems[0] as TranscriptMessageItem).text).toBe('a'.repeat(400));

    replay.stepForward();
    flushSync();
    expect(replay.displayItems.map((item) => item.id)).toEqual(['m1', 'tc2']);
    expect(replay.finished).toBe(true);
  });

  it('stepBack rewinds to the start of the previous item, never past the beginning', () => {
    const items = [toolCallItem('tc1'), toolCallItem('tc2'), toolCallItem('tc3')];
    const replay = new SessionReplay(items);
    replay.skipToEnd();
    flushSync();

    replay.stepBack();
    flushSync();
    expect(replay.displayItems.map((item) => item.id)).toEqual(['tc1', 'tc2']);

    replay.stepBack();
    replay.stepBack();
    replay.stepBack();
    flushSync();
    expect(replay.displayItems).toEqual([]);
    expect(replay.positionMs).toBe(0);
  });

  it('restart replays from the very beginning even mid-playback', () => {
    const replay = new SessionReplay([toolCallItem('tc1'), toolCallItem('tc2')]);
    replay.play();
    vi.advanceTimersByTime(500);
    flushSync();
    expect(replay.displayItems.length).toBeGreaterThan(0);

    replay.restart();
    flushSync();
    expect(replay.positionMs).toBe(0);
    expect(replay.playing).toBe(true);
  });

  it('play() after finishing starts over from the beginning, like a finished video replaying', () => {
    const replay = new SessionReplay([toolCallItem('tc1')]);
    replay.skipToEnd();
    flushSync();
    expect(replay.finished).toBe(true);

    replay.play();
    flushSync();
    expect(replay.positionMs).toBe(0);
    expect(replay.playing).toBe(true);
  });

  it('setItems resets position and stops playback for a fresh transcript', () => {
    const replay = new SessionReplay([toolCallItem('tc1')]);
    replay.play();
    vi.advanceTimersByTime(500);

    replay.setItems([toolCallItem('other1'), toolCallItem('other2')]);
    flushSync();
    expect(replay.positionMs).toBe(0);
    expect(replay.playing).toBe(false);
    expect(replay.displayItems).toEqual([]);
  });

  it('destroy stops the timer for good — a destroyed replay never advances again even if play() was never explicitly paused first', () => {
    const replay = new SessionReplay([messageItem({ text: 'a'.repeat(400) })]);
    replay.play();
    vi.advanceTimersByTime(1000);
    flushSync();
    const positionBeforeDestroy = replay.positionMs;

    replay.destroy();
    vi.advanceTimersByTime(5000);
    flushSync();
    expect(replay.positionMs).toBe(positionBeforeDestroy);
  });

  it('gap and revival items pass through as atomic, unmodified items — only a message item is ever truncated', () => {
    const gap: TranscriptItem = { type: 'gap', id: 'gap::1::5', fromSeq: 1, toSeq: 5 };
    const revival: TranscriptItem = {
      type: 'revival',
      id: 'revival::2026-01-01T00:00:00.000Z',
      reason: 'Reviving this session: a brand-new agent process started here.',
    };
    const replay = new SessionReplay([gap, revival]);
    replay.play();
    vi.advanceTimersByTime(60);
    flushSync();
    expect(replay.displayItems[0]).toEqual(gap);

    replay.skipToEnd();
    flushSync();
    expect(replay.displayItems).toEqual([gap, revival]);
  });

  it('an empty transcript is immediately finished and never throws', () => {
    const replay = new SessionReplay([]);
    expect(replay.finished).toBe(true);
    expect(replay.totalDurationMs).toBe(0);
    expect(replay.displayItems).toEqual([]);
    replay.play();
    expect(replay.playing).toBe(false);
  });

  it('revealing is true only while genuinely mid-reveal, false once paused or finished', () => {
    const replay = new SessionReplay([messageItem({ text: 'a'.repeat(400) })]);
    expect(replay.revealing).toBe(false);
    replay.play();
    vi.advanceTimersByTime(1000);
    flushSync();
    expect(replay.revealing).toBe(true);
    replay.pause();
    expect(replay.revealing).toBe(false);
  });
});
