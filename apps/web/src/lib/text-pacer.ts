/**
 * Decouples chunk arrival from render rate for a streaming message's text
 * (SPEC.md §7.24 "Streaming mechanics"; issue #137): a fast, low-latency
 * agent can append many characters to a `TranscriptMessageItem.text` per
 * animation frame — dumping the full string straight into the DOM on every
 * chunk causes visible per-frame jank on a long burst. `TextPacer` instead
 * tracks a "target" length (the real, already-reduced text this client has
 * — content is never dropped or delayed at the *data* layer, only at
 * render) and reveals it a bounded number of characters per tick, calling
 * back with how much to show so far.
 *
 * A plain `setInterval` loop, not `requestAnimationFrame`: this needs to
 * run identically in a component test (jsdom, no rAF driving a real
 * compositor) as in a real browser tab, and a ~60Hz interval is smooth
 * enough for text reveal (unlike a canvas/video frame budget). The reveal
 * rate scales with backlog size — a fixed small step would let a huge
 * burst lag for seconds behind the real text, which is exactly the kind of
 * jank/lag issue #137 is about avoiding in the other direction — so a
 * bigger backlog reveals proportionally faster while a small one still
 * reveals gently, and {@link TextPacer.flush} always jumps straight to the
 * full target instantly (the `turn_ended` guarantee: nothing is ever left
 * un-revealed once a turn settles).
 */
export interface TextPacerOptions {
  /** Ms between reveal ticks. Defaults to 32 (~30Hz — smooth for text, cheap). */
  tickMs?: number;
  /** The minimum characters revealed per tick once behind at all. Defaults to 2. */
  minCharsPerTick?: number;
  /** Fraction of the outstanding backlog revealed per tick (on top of `minCharsPerTick`), so a big burst catches up faster than a trickle. Defaults to 0.35. */
  catchUpFraction?: number;
  /** Called with the new revealed-length every time it changes. */
  onReveal: (revealedLength: number) => void;
  /** Seeds both `revealed` and the initial target without firing `onReveal` — for a caller that already knows its starting length (e.g. replayed history that should render in full immediately, never "typed out"). Defaults to 0. */
  initialLength?: number;
}

const DEFAULT_TICK_MS = 32;
const DEFAULT_MIN_CHARS_PER_TICK = 2;
const DEFAULT_CATCH_UP_FRACTION = 0.35;

export class TextPacer {
  private readonly tickMs: number;
  private readonly minCharsPerTick: number;
  private readonly catchUpFraction: number;
  private readonly onReveal: (revealedLength: number) => void;

  private targetLength = 0;
  private revealedLength = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: TextPacerOptions) {
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.minCharsPerTick = options.minCharsPerTick ?? DEFAULT_MIN_CHARS_PER_TICK;
    this.catchUpFraction = options.catchUpFraction ?? DEFAULT_CATCH_UP_FRACTION;
    this.onReveal = options.onReveal;
    const initial = options.initialLength ?? 0;
    this.revealedLength = initial;
    this.targetLength = initial;
  }

  /** How much of the text is currently revealed. */
  get revealed(): number {
    return this.revealedLength;
  }

  /**
   * Sets the real, fully-reduced text length this pacer should catch up
   * to — call this every time the source item's `text` grows (or shrinks,
   * though the reducer never shrinks it in practice). Never itself reveals
   * anything synchronously; only the ticking loop (or {@link flush}) moves
   * `revealed` forward, so a burst of `setTarget` calls in one animation
   * frame still only produces one bounded reveal step per tick.
   */
  setTarget(length: number): void {
    this.targetLength = length;
    // A target can also shrink back below what's already revealed (a new,
    // shorter item reusing this pacer instance) — clamp down immediately,
    // nothing to "pace" about revealing less.
    if (this.revealedLength > this.targetLength) {
      this.revealedLength = this.targetLength;
      this.onReveal(this.revealedLength);
    }
    this.ensureRunning();
  }

  /**
   * Jumps straight to the full target instantly (issue #137's "must flush
   * fully on turn_ended") and stops the ticking loop — nothing is left
   * un-revealed once a turn settles, and this pacer has revealed everything
   * it currently knows about.
   */
  flush(): void {
    this.stop();
    if (this.revealedLength === this.targetLength) return;
    this.revealedLength = this.targetLength;
    this.onReveal(this.revealedLength);
  }

  /** Stops the ticking loop without changing what has been revealed so far — call on unmount to avoid a leaked timer. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private ensureRunning(): void {
    if (this.timer !== undefined || this.revealedLength >= this.targetLength) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  private tick(): void {
    const backlog = this.targetLength - this.revealedLength;
    if (backlog <= 0) {
      this.stop();
      return;
    }
    const step = Math.min(
      backlog,
      Math.max(this.minCharsPerTick, Math.ceil(backlog * this.catchUpFraction)),
    );
    this.revealedLength += step;
    this.onReveal(this.revealedLength);
    if (this.revealedLength >= this.targetLength) this.stop();
  }
}
