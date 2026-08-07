import type { TranscriptItem } from '@loombox/providers-core/browser';

/**
 * Replays a past session's already-synced transcript at a controllable,
 * synthetic pace (issue #265, SPEC.md §7.19 "the ability to fork or replay
 * a past session"). Distinct from forking (#264/#746): replay never
 * touches the workspace or spawns an agent, it only controls how fast the
 * transcript this client already has reveals on screen.
 *
 * Deliberately does NOT try to reproduce the session's real wall-clock
 * timing. Two reasons, not one:
 *
 * 1. Watching a two-hour session unfold in real time is useless (this
 *    issue's own design brief) — a controllable pace has to compress it
 *    regardless of whether real gap durations are known.
 * 2. They usually aren't known. `TranscriptToolCallItem.startedAtMs`'s own
 *    doc comment: a tool call is timed ONLY the instant this client
 *    watches it go from non-terminal to terminal live; a session synced
 *    via `resync_request` backfill (exactly how a past session's
 *    read-only transcript reaches this client per issue #730) sees every
 *    call already `completed`/`failed` on first sighting, so
 *    `startedAtMs` is `undefined` for effectively every item in the
 *    common "open a session you didn't watch live" case. There is no
 *    honest per-item real-time signal to reconstruct pacing from.
 *
 * So the honest design is the other direction: never claim a timing
 * fidelity that isn't there. Each item gets a synthetic duration (a
 * message's proportional to its text length, everything else a fixed
 * beat, both scaled by {@link speed}), and `displayItems`/`revealedCount`
 * always expose exactly where playback is in the real, complete item
 * sequence — scrubbing or skipping ahead is always visible as a jump in
 * that position, never a silent one. Nothing is ever elided from the
 * final transcript itself (unlike a `TranscriptGapItem`, which marks
 * content the RELAY already lost) — replay only ever changes how fast you
 * get to the end, never what you see once you're there.
 */

/** Playback speed presets the control bar offers — fixed steps, not a free dial: pacing here is already synthetic (see the class doc comment), so a continuous scrubber would imply a precision this model doesn't have. */
export const REPLAY_SPEEDS = [1, 2, 4, 8] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** ~40 characters/second at 1x — a readable "unfolding" pace, faster than average reading speed on purpose (the reader catches up on the fully-revealed text a moment after each burst, exactly like live streaming already reads). */
const BASE_CHARS_PER_SEC = 40;
/** A message this short (or empty) still gets a visible beat rather than flashing in over 0ms. */
const MIN_MESSAGE_MS = 260;
/** A non-text item's own pause before the next item appears — long enough to register as a distinct step, short enough that a long session stays watchable. */
const STEP_ITEM_MS = 650;
/** Extra pause where the turn changes — a human-scale "and then" beat between turns, not a claim about the real gap (see the class doc comment). */
const TURN_BOUNDARY_MS = 450;
/** How often the playback timer advances `positionMs` while playing. */
const TICK_MS = 50;

/** `setInterval`'s handle type — named once rather than written inline as `ReturnType<typeof setInterval>`, mirroring `relay-client.ts`'s identical `TimerHandle` alias (same handle type as `setTimeout` in both environments this bundle runs in: `number` in a browser, `NodeJS.Timeout` under Node/SSR). */
type TimerHandle = ReturnType<typeof setInterval>;

/** This item's own synthetic duration at 1x speed. */
function itemDurationMs(item: TranscriptItem, turnChanged: boolean): number {
  const bonus = turnChanged ? TURN_BOUNDARY_MS : 0;
  if (item.type === 'message') {
    return Math.max(MIN_MESSAGE_MS, (item.text.length / BASE_CHARS_PER_SEC) * 1000) + bonus;
  }
  return STEP_ITEM_MS + bonus;
}

/** Largest `i` in `[0, cumulative.length)` with `cumulative[i] <= value` — `cumulative` is non-decreasing (every duration is positive) so a binary search is exact, not an approximation. */
function lastIndexAtMost(cumulative: readonly number[], value: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (cumulative[mid]! <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export class SessionReplay {
  /** The full, final item sequence being replayed — never mutated once set; `setItems`/the constructor replace the whole reference, mirroring `TranscriptWindow.items`' own `$state.raw` convention. */
  items: readonly TranscriptItem[] = $state.raw([]);
  /** Virtual elapsed time, in ms, at 1x speed — the single source of truth for both playback and scrubbing. `0..totalDurationMs`. */
  positionMs = $state(0);
  playing = $state(false);
  speed: ReplaySpeed = $state(1);

  #timerId: TimerHandle | undefined;
  #lastTickAt: number | undefined;

  constructor(items: readonly TranscriptItem[] = []) {
    this.items = items;
  }

  /** Each item's own 1x-speed duration, computed once per `items` reference. */
  readonly #durations = $derived.by((): number[] => {
    const items = this.items;
    const durations = new Array<number>(items.length);
    let previousTurnId: string | undefined;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      const turnId = item.type === 'message' || item.type === 'tool_call' ? item.turnId : undefined;
      const turnChanged = i > 0 && turnId !== undefined && turnId !== previousTurnId;
      durations[i] = itemDurationMs(item, turnChanged);
      if (turnId !== undefined) previousTurnId = turnId;
    }
    return durations;
  });

  /** `cumulative[i]` is the position at which item `i` starts revealing; `cumulative[items.length]` is the total duration. */
  readonly #cumulative = $derived.by((): number[] => {
    const durations = this.#durations;
    const cumulative = new Array<number>(durations.length + 1);
    cumulative[0] = 0;
    for (let i = 0; i < durations.length; i += 1) {
      cumulative[i + 1] = cumulative[i]! + durations[i]!;
    }
    return cumulative;
  });

  readonly totalDurationMs = $derived(this.#cumulative.at(-1) ?? 0);

  /** How many items are FULLY revealed at the current position — `items.length` once finished. */
  readonly revealedCount = $derived(lastIndexAtMost(this.#cumulative, this.positionMs));

  /**
   * What actually renders: every fully-revealed item, plus (unless
   * playback is already finished) the one item currently mid-reveal.
   * Every item type but `message` has no partial state of its own — it
   * appears whole the instant its reveal window starts, the same "no
   * timestamp to time a partial state against" reasoning
   * `TranscriptToolCallItem.startedAtMs`'s doc comment already applies to
   * a resumed session's history. A `message` item's `text` is truncated
   * to however much of its own duration has elapsed, so prose visibly
   * "unfolds" rather than appearing as one paint — this is the one place
   * this class reuses the deleted `TextPacer`'s actual idea (reveal text
   * progressively), not its code, which issue #757 removed entirely once
   * live streaming stopped needing it.
   */
  readonly displayItems = $derived.by((): TranscriptItem[] => {
    const revealed = this.revealedCount;
    const items = this.items;
    const prefix = items.slice(0, revealed);
    if (revealed >= items.length) return prefix;

    const current = items[revealed]!;
    const start = this.#cumulative[revealed]!;
    // No item shows before ANY time has elapsed inside its own window —
    // matters at `positionMs === start` exactly (freshly seeked/reset to
    // this item's own boundary): a non-message item has no partial state
    // (see the doc comment above), so without this guard it would appear
    // a tick before it's actually due, the same "off by one boundary"
    // `displayItems` must never have for a message item either.
    if (this.positionMs <= start) return prefix;
    if (current.type !== 'message' || current.text.length === 0) {
      return [...prefix, current];
    }
    const duration = this.#durations[revealed]!;
    const fraction =
      duration > 0 ? Math.min(1, Math.max(0, (this.positionMs - start) / duration)) : 1;
    const revealedLength = Math.floor(current.text.length * fraction);
    if (revealedLength <= 0) return prefix;
    return [...prefix, { ...current, text: current.text.slice(0, revealedLength) }];
  });

  readonly finished = $derived(this.positionMs >= this.totalDurationMs);

  /**
   * True while `displayItems`' own last row is genuinely still mid-reveal
   * — feeds `TranscriptTimeline`'s `turnActive` prop so an item that
   * hasn't finished revealing gets the exact same "not finalized yet"
   * Markdown handling a live-streaming message gets (`MessageItem.svelte`'s
   * `splitStreamingMarkdown` contract), and an already-fully-revealed
   * historical item does not — it has nothing left unterminated to mask.
   */
  readonly revealing = $derived(this.playing && !this.finished);

  /** Swaps in a different transcript — a new replay, or the same one restarted from a different source array. Always resets to the beginning and stops any running timer, mirroring `TranscriptWindow.reset()`'s "a new session is a different transcript" convention. */
  setItems(items: readonly TranscriptItem[]): void {
    this.pause();
    this.items = items;
    this.positionMs = 0;
  }

  /** Starts (or resumes) playback. Restarts from the beginning once finished — the same "the finished state's own play control replays" convention a video player uses. */
  play(): void {
    if (this.items.length === 0) return;
    if (this.finished) this.positionMs = 0;
    this.playing = true;
    this.#ensureTimer();
  }

  pause(): void {
    this.playing = false;
    this.#clearTimer();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Jumps back to the very start and plays from there. */
  restart(): void {
    this.positionMs = 0;
    this.play();
  }

  /** Jumps straight to the end and stops — every item is fully revealed, nothing further to play. */
  skipToEnd(): void {
    this.pause();
    this.positionMs = this.totalDurationMs;
  }

  setSpeed(speed: ReplaySpeed): void {
    this.speed = speed;
  }

  /**
   * Scrubs directly to `ms`, clamped to `[0, totalDurationMs]`. Pauses
   * first — the same "grabbing the scrubber stops playback" convention a
   * video player uses, so a drag gesture never races the timer's own
   * advance mid-drag. The caller (the control bar's range input) is free
   * to call {@link play} again afterward if it wants scrub-then-resume.
   */
  seekMs(ms: number): void {
    this.pause();
    this.positionMs = Math.max(0, Math.min(this.totalDurationMs, ms));
  }

  /** Completes revealing whichever item is currently in progress (or starts the next one, if the current position already sits exactly on an item boundary) and stops there — the step-through half of issue #265's acceptance bullet, independent of continuous playback. */
  stepForward(): void {
    const next = Math.min(this.items.length, this.revealedCount + 1);
    this.seekMs(this.#cumulative[next] ?? this.totalDurationMs);
  }

  /** Rewinds to the start of the previous item's reveal window. */
  stepBack(): void {
    const previous = Math.max(0, this.revealedCount - 1);
    this.seekMs(this.#cumulative[previous] ?? 0);
  }

  #ensureTimer(): void {
    if (this.#timerId !== undefined) return;
    this.#lastTickAt = Date.now();
    this.#timerId = setInterval(() => {
      const now = Date.now();
      const dt = now - (this.#lastTickAt ?? now);
      this.#lastTickAt = now;
      this.positionMs = Math.min(this.totalDurationMs, this.positionMs + dt * this.speed);
      if (this.positionMs >= this.totalDurationMs) this.pause();
    }, TICK_MS);
  }

  #clearTimer(): void {
    if (this.#timerId === undefined) return;
    clearInterval(this.#timerId);
    this.#timerId = undefined;
    this.#lastTickAt = undefined;
  }

  /** Stops any running timer for good — the owning component's cleanup, so leaving replay (or navigating away entirely) never leaves an interval ticking in the background against a transcript nothing renders anymore. */
  destroy(): void {
    this.#clearTimer();
  }
}
