<script lang="ts">
  /**
   * A visible "history gap" row (issue #729, SPEC.md §7.16's bounded
   * per-client ring: "drop-oldest + a resync marker on overflow"). Renders
   * a `TranscriptGapItem` — the client-side reduction of a relay
   * `resync_marker` whose `dropped: true` means the ring already evicted
   * `[fromSeq, toSeq]` before any resync could replay it. Deliberately its
   * own quiet row, not a modal or a page-level banner: unlike #730's
   * no-live-agent notice (a session-wide, still-actionable state shown
   * once above the transcript), a gap is a permanent, historical fact about
   * ONE stretch of a transcript that otherwise keeps rendering normally
   * above and below it — so it reads inline, at the exact point in the
   * timeline where the missing updates would have been.
   *
   * Warning-tinted (`--color-warning`), not danger: nothing is currently
   * broken — the session itself may be fine — this is a permanent record
   * that some history is unrecoverable, closer to `ErrorNotice`'s
   * `retryable` reading than its fatal one, except there is nothing to
   * retry here (issue #729's acceptance: "a dropped-range marker renders
   * as a gap the user can see", not an action to take).
   */
  import type { TranscriptGapItem } from '@loombox/providers-core/browser';
  import Icon from './icons/Icon.svelte';

  interface Props {
    item: TranscriptGapItem;
  }

  const { item }: Props = $props();
</script>

<div class="transcript-gap" role="status" data-testid="transcript-gap">
  <Icon name="alert" size="16" />
  <span class="transcript-gap-text">
    History gap (updates {item.fromSeq}–{item.toSeq}) — some updates weren't saved by the relay and
    can't be recovered.
  </span>
</div>

<style>
  .transcript-gap {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    width: 100%;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-warning-subtle);
    border: 1px solid var(--color-warning);
    color: var(--color-warning);
    animation: beat-in var(--duration-base) var(--ease-beat) both;
  }

  .transcript-gap-text {
    font-size: var(--text-small-size);
    line-height: var(--text-small-line);
  }

  @keyframes beat-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
