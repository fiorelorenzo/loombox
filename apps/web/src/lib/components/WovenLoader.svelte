<script lang="ts">
  /**
   * The "woven-thread" loading/working motif (SPEC.md §4: "Woven-thread
   * lines are the recurring motif: loading and 'agent working' states
   * animate as threads being woven"; issue #274). A small reusable
   * indicator, geometrically related to `BrandMark`'s warp/weft strands (a
   * 2x2 plain weave) but built for continuous motion rather than a static
   * mark: three "warp" (vertical) threads and two "weft" (horizontal)
   * threads, each animated with a traveling dash so the crossing points
   * read as threads sliding over/under one another rather than a generic
   * spinner.
   *
   * Two states (issue #274's acceptance): `loading` (indeterminate — an
   * unknown-duration wait, e.g. "looking for nodes") and `working`
   * (continuous — a live, ongoing process, e.g. the agent's turn is
   * streaming). Both are driven entirely by CSS `@keyframes` (no JS frame
   * loop, for battery/perf on mobile per the issue's acceptance); `working`
   * simply runs the same weave a little slower and steadier, since it can
   * run indefinitely behind a whole live turn rather than a single fetch.
   *
   * `size="sm"` is `1em` square, meant to sit inline next to button/status
   * text (matches `BrandMark`'s own inline sizing convention); `size="md"`
   * is a fixed, larger panel size for a standalone loading section.
   *
   * Respects `prefers-reduced-motion: reduce` automatically (CSS media
   * query, freezes to a static low-opacity weave); `reducedMotion` is an
   * explicit override to the same static fallback, for callers that already
   * track a user's reduced-motion preference elsewhere and for deterministic
   * component tests (jsdom doesn't evaluate `prefers-reduced-motion`).
   */
  interface Props {
    /** `sm` (default) sits inline with text/buttons; `md` is a standalone panel size. */
    size?: 'sm' | 'md';
    /** `loading` (default) for an indeterminate wait; `working` for a continuous, ongoing process (e.g. a live agent turn). */
    variant?: 'loading' | 'working';
    /** Forces the static reduced-motion fallback regardless of the media query. */
    reducedMotion?: boolean;
    /** Accessible name for the `role="status"` root. */
    label?: string;
    /** Additional class name(s) merged onto the root element. */
    class?: string;
  }

  const {
    size = 'sm',
    variant = 'loading',
    reducedMotion = false,
    label = 'Loading',
    class: className = '',
  }: Props = $props();
</script>

<span
  class={`woven-loader woven-loader-${size} woven-loader-${variant} ${className}`.trim()}
  role="status"
  aria-label={label}
  data-testid="woven-loader"
  data-size={size}
  data-variant={variant}
  data-reduced-motion={reducedMotion ? 'true' : 'false'}
>
  <svg
    viewBox="0 0 32 32"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <path class="thread warp warp-1" d="M9 3 V29" />
    <path class="thread warp warp-2" d="M16 3 V29" />
    <path class="thread warp warp-3" d="M23 3 V29" />
    <path class="thread weft weft-1" d="M3 12 H29" />
    <path class="thread weft weft-2" d="M3 21 H29" />
  </svg>
</span>

<style>
  .woven-loader {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--color-accent);
  }

  .woven-loader-sm {
    width: 1em;
    height: 1em;
  }

  .woven-loader-md {
    width: 2.5rem;
    height: 2.5rem;
  }

  .woven-loader svg {
    width: 100%;
    height: 100%;
  }

  .thread {
    stroke-width: 3.2;
    stroke-dasharray: 5 4;
    animation-name: weave;
    animation-duration: 1.1s;
    animation-timing-function: ease-in-out;
    animation-iteration-count: infinite;
  }

  /* `working` (a continuous, ongoing process) runs the same weave slower
     and linearly rather than eased — steadier, meant to sit unobtrusively
     behind a whole live turn instead of calling attention to a short wait. */
  .woven-loader-working .thread {
    animation-duration: 1.8s;
    animation-timing-function: linear;
  }

  .warp-2,
  .weft-1 {
    animation-delay: -0.28s;
  }

  .warp-3,
  .weft-2 {
    animation-delay: -0.56s;
  }

  @keyframes weave {
    0% {
      stroke-dashoffset: 18;
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
    100% {
      stroke-dashoffset: 0;
      opacity: 0.45;
    }
  }

  /* Calm static fallback (issue #274's acceptance: "respects
     prefers-reduced-motion with a static fallback") — no motion, a fixed
     partial-opacity weave that still reads as the brand mark. Both the
     media query (a browser/OS-level preference) and the explicit
     `data-reduced-motion` override (a caller-tracked preference, or a test)
     resolve to the exact same static look. */
  @media (prefers-reduced-motion: reduce) {
    .thread {
      animation: none;
      stroke-dashoffset: 0;
      opacity: 0.6;
    }
  }

  .woven-loader[data-reduced-motion='true'] .thread {
    animation: none;
    stroke-dashoffset: 0;
    opacity: 0.6;
  }
</style>
