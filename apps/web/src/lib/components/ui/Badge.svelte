<script lang="ts">
  /**
   * The shared status/tag pill (v6 design-system audit §1.4, issue #579):
   * hand-rolled four times before this — `McpServerConfigPanel`'s
   * `.secret-badge`, `TargetPicker`'s `.kind-badge`/`.unreachable-badge`, and
   * `TargetStatusView`'s own duplicate `.kind-badge` plus its
   * `.agent-health-badge` (which redrew a status dot inline instead of
   * composing the real `StatusDot`). Diffing all four, they differ on
   * exactly three things — tone, an optional leading dot, and size — so
   * that is exactly what this supports, nothing invented on top. Each
   * hand-rolled copy also disagreed on details that carry no meaning of
   * their own (radius-sm vs radius-full, which padding step, which
   * font-size step); this unifies to one canonical pill shape (radius-full)
   * and two size steps rather than every call site's own guess.
   *
   * `dot` composes the real `StatusDot` (never redraws its ring/pulse/
   * crossfade — see that component's own file doc comment for the motion
   * contract that comes along for free) at the tone this badge is already
   * rendering with, so the two never disagree. `dotLabel` is the dot's own
   * accessible name — required whenever `dot` is set, exactly like
   * `StatusDot`'s own `label` — most callers already have the matching
   * visible text at hand (e.g. `TargetStatusView`'s health badge passes the
   * same string it renders).
   */
  import type { Snippet } from 'svelte';
  import StatusDot, { type StatusTone } from './StatusDot.svelte';

  export type BadgeTone = StatusTone;
  export type BadgeSize = 'sm' | 'md';

  interface Props {
    tone?: BadgeTone;
    /** Composes a leading `StatusDot` at this badge's own tone — see the file doc comment. */
    dot?: boolean;
    /** The composed dot's accessible name. Required when `dot` is true. */
    dotLabel?: string;
    /** Forwarded to the composed `StatusDot`'s own `pulse` — a badge whose dot marks an ongoing/live state (issue #652's `PermissionQueueBar` adoption, where more than one item pending is worth a continuous pulse, not just a static dot). */
    dotPulse?: boolean;
    size?: BadgeSize;
    /** Additional class name(s) merged onto the root element. */
    class?: string;
    dataTestId?: string;
    /** Arbitrary `data-*`/`aria-*` passthrough — same escape hatch as `Button`/`Row` (issue #579), e.g. a call site's own `data-kind` marker. */
    [key: `data-${string}` | `aria-${string}`]: unknown;
    children: Snippet;
  }

  const {
    tone = 'neutral',
    dot = false,
    dotLabel,
    dotPulse = false,
    size = 'sm',
    class: className = '',
    dataTestId = 'ui-badge',
    children,
    ...rest
  }: Props = $props();
</script>

<span
  {...rest}
  class={`ui-badge ui-badge-${tone} ui-badge-${size} ${className}`.trim()}
  data-testid={dataTestId}
  data-tone={tone}
>
  {#if dot}
    <StatusDot {tone} label={dotLabel ?? ''} pulse={dotPulse} size="sm" />
  {/if}
  {@render children()}
</span>

<style>
  .ui-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    border-radius: var(--radius-full);
    font-weight: 600;
    white-space: nowrap;
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .ui-badge-sm {
    padding: var(--space-3xs) var(--space-xs);
    font-size: var(--text-caption-size);
  }

  .ui-badge-md {
    padding: var(--space-2xs) var(--space-sm);
    font-size: var(--text-small-size);
  }

  /* Tone ladder — mirrors StatusDot's own `data-tone` vocabulary exactly,
     so the two primitives never carry a second, independent color scale. */
  .ui-badge-neutral {
    background: var(--color-fill);
    color: var(--color-text-secondary);
  }

  .ui-badge-success {
    background: var(--color-success-subtle);
    color: var(--color-success);
  }

  .ui-badge-warning {
    background: var(--color-warning-subtle);
    color: var(--color-warning);
  }

  .ui-badge-danger {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
  }

  .ui-badge-info {
    background: var(--color-info-subtle);
    color: var(--color-info);
  }
</style>
