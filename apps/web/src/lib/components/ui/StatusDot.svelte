<script lang="ts">
  /**
   * The shared status indicator (redesign brief `docs/design/redesign.md`
   * §4, issue #428): a small dot in one of the app's four semantic status
   * colors (or a neutral default), with an optional continuous pulse for a
   * live/ongoing state (e.g. a working session). Shared by session rows,
   * the header's target-health cluster, and `TargetStatusView` (call-site
   * migration is a later, per-surface issue; this ships the primitive plus
   * a `/style-reference` proof-of-use only) — those call sites map their
   * own status vocabulary (`SessionStatusV1`, `TargetStatusView`'s
   * `HealthState`, `ConnectionStatus`) onto this component's plain
   * `tone`/`pulse` pair rather than this primitive knowing about any of
   * them.
   *
   * Motion:
   * - The pulse is `thread-draw` (redesign brief §2 table) —
   *   `WovenLoader`'s own `stroke-dashoffset` weave technique, formalized
   *   as a second reusable motion primitive, not a generic CSS
   *   box-shadow "ping". `--duration-weave` linear, continuous, per the
   *   table's "continuous fills" row.
   * - A `tone` change (e.g. `working` → `permission_required`) crossfades
   *   via a plain CSS `transition` on the dot's own color — exactly
   *   `status-crossfade`'s documented job (`--duration-fast`/`--ease-beat`,
   *   "color/background crossfade, no snap"), no JS involved.
   * - Reduced motion mirrors `WovenLoader`'s own dual contract: the
   *   `prefers-reduced-motion` media query freezes the ring automatically,
   *   and an explicit `reducedMotion` prop gives callers/tests the same
   *   static fallback deterministically (jsdom doesn't evaluate the media
   *   query).
   */
  export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  export type StatusDotSize = 'sm' | 'md';

  interface Props {
    tone?: StatusTone;
    /** A continuous thread-draw pulse for an ongoing/live state (e.g. a working session). */
    pulse?: boolean;
    /** Accessible name — status dots carry meaning, never decorative-only. */
    label: string;
    size?: StatusDotSize;
    /** Forces the static reduced-motion fallback regardless of the media query (see the file doc comment). */
    reducedMotion?: boolean;
    /** Additional class name(s) merged onto the root element. */
    class?: string;
  }

  const {
    tone = 'neutral',
    pulse = false,
    label,
    size = 'sm',
    reducedMotion = false,
    class: className = '',
  }: Props = $props();
</script>

<span
  class={`ui-status-dot ui-status-dot-${size} ${className}`.trim()}
  role="img"
  aria-label={label}
  data-testid="ui-status-dot"
  data-tone={tone}
  data-pulse={pulse}
  data-reduced-motion={reducedMotion ? 'true' : 'false'}
>
  {#if pulse}
    <svg
      class="ui-status-dot-ring"
      viewBox="0 0 20 20"
      aria-hidden="true"
      data-testid="ui-status-dot-ring"
    >
      <circle class="ring-draw" cx="10" cy="10" r="8" />
    </svg>
  {/if}
  <span class="ui-status-dot-core" aria-hidden="true"></span>
</span>

<style>
  .ui-status-dot {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--color-fill);
  }

  .ui-status-dot-sm {
    width: 0.55rem;
    height: 0.55rem;
  }

  .ui-status-dot-md {
    width: 0.85rem;
    height: 0.85rem;
  }

  .ui-status-dot-core {
    position: absolute;
    inset: 20%;
    border-radius: var(--radius-full);
    background: currentColor;
    /* status-crossfade (redesign brief §2): a tone change crossfades color, no snap. */
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .ui-status-dot[data-tone='success'] {
    color: var(--color-success);
  }

  .ui-status-dot[data-tone='warning'] {
    color: var(--color-warning);
  }

  .ui-status-dot[data-tone='danger'] {
    color: var(--color-danger);
  }

  .ui-status-dot[data-tone='info'] {
    color: var(--color-info);
  }

  .ui-status-dot-ring {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .ring-draw {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    /* circumference for r=8: 2 * PI * 8 ≈ 50.27 */
    stroke-dasharray: 50.27;
    animation: thread-draw-pulse var(--duration-weave) linear infinite;
    opacity: 0.6;
  }

  @keyframes thread-draw-pulse {
    0% {
      stroke-dashoffset: 50.27;
      opacity: 0;
    }
    50% {
      opacity: 0.6;
    }
    100% {
      stroke-dashoffset: 0;
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ring-draw {
      animation: none;
      stroke-dashoffset: 0;
      opacity: 0.35;
    }
  }

  .ui-status-dot[data-reduced-motion='true'] .ring-draw {
    animation: none;
    stroke-dashoffset: 0;
    opacity: 0.35;
  }
</style>
