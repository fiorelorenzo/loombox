import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextPacer } from './text-pacer';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TextPacer (#137)', () => {
  it('reveals incrementally rather than jumping straight to the full target', () => {
    const revealed: number[] = [];
    const pacer = new TextPacer({ tickMs: 10, onReveal: (n) => revealed.push(n) });

    pacer.setTarget(100);
    vi.advanceTimersByTime(10);

    expect(revealed.length).toBeGreaterThan(0);
    expect(revealed[0]).toBeGreaterThan(0);
    expect(revealed[0]).toBeLessThan(100);
  });

  it('never drops content: repeated ticks eventually reach the full target with no reveal ever exceeding it', () => {
    const revealed: number[] = [];
    const pacer = new TextPacer({ tickMs: 10, onReveal: (n) => revealed.push(n) });

    pacer.setTarget(37);
    vi.advanceTimersByTime(10 * 50);

    expect(pacer.revealed).toBe(37);
    expect(revealed.every((n) => n <= 37)).toBe(true);
    // Monotonically non-decreasing — nothing revealed is ever un-revealed.
    for (let i = 1; i < revealed.length; i++) {
      expect(revealed[i]).toBeGreaterThanOrEqual(revealed[i - 1]);
    }
  });

  it('a growing target (more chunks arriving mid-reveal) is still caught up to fully, never stalls short', () => {
    const pacer = new TextPacer({ tickMs: 10, onReveal: () => {} });
    pacer.setTarget(10);
    vi.advanceTimersByTime(20);
    pacer.setTarget(500); // a burst arrives while still catching up to the first target
    vi.advanceTimersByTime(10 * 200);
    expect(pacer.revealed).toBe(500);
  });

  it('flush jumps straight to the full target instantly and stops ticking (issue #137: must flush fully on turn_ended)', () => {
    const revealed: number[] = [];
    const pacer = new TextPacer({ tickMs: 10, onReveal: (n) => revealed.push(n) });
    pacer.setTarget(200);
    vi.advanceTimersByTime(10); // one small step, well short of 200

    pacer.flush();
    expect(pacer.revealed).toBe(200);

    const callCountAfterFlush = revealed.length;
    vi.advanceTimersByTime(10 * 10);
    // No further ticks after flush — the interval was stopped.
    expect(revealed.length).toBe(callCountAfterFlush);
  });

  it('stop() halts the loop without changing what was already revealed', () => {
    const pacer = new TextPacer({ tickMs: 10, onReveal: () => {} });
    pacer.setTarget(1000);
    vi.advanceTimersByTime(10);
    const before = pacer.revealed;
    pacer.stop();
    vi.advanceTimersByTime(10 * 100);
    expect(pacer.revealed).toBe(before);
  });
});
