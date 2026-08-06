<script lang="ts">
  /**
   * Shared elapsed-time / attributed-cost badge for a tool-call row's
   * header line (issue #744, decisions doc C3-3) — reused by
   * `GenericToolRow` and every `tool-widgets/*` bespoke widget so both
   * figures render identically everywhere a tool-call header line exists,
   * the same "one shared subcomponent, not N copies" convention
   * `ToolCallGutter`/`ToolCallStatus` already established for the icon and
   * status columns.
   *
   * Renders nothing at all when both figures are `undefined` — a call
   * whose start this client never observed (issue #744's resumed-session
   * acceptance bullet) or with nothing honestly attributable never grows
   * an empty badge. See `@loombox/providers-core`'s
   * `TranscriptToolCallItem.elapsedMs`/`.attributedCostUsd` doc comments
   * (`packages/providers/core/src/transcript.ts`) for exactly when each is
   * set — this component only formats, it never decides.
   */
  import { formatAttributedCost, formatToolCallElapsed } from '$lib/tool-widgets';

  interface Props {
    elapsedMs: number | undefined;
    attributedCostUsd: number | undefined;
  }

  const { elapsedMs, attributedCostUsd }: Props = $props();

  const elapsedLabel = $derived(
    elapsedMs !== undefined ? formatToolCallElapsed(elapsedMs) : undefined,
  );
  const costLabel = $derived(
    attributedCostUsd !== undefined ? formatAttributedCost(attributedCostUsd) : undefined,
  );
</script>

{#if elapsedLabel || costLabel}
  <span class="tool-call-meta" data-testid="tool-call-meta">
    {#if elapsedLabel}<span class="tool-call-elapsed">{elapsedLabel}</span>{/if}
    {#if costLabel}<span class="tool-call-cost">{costLabel}</span>{/if}
  </span>
{/if}

<style>
  .tool-call-meta {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2xs);
    flex-shrink: 0;
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
    font-variant-numeric: tabular-nums;
  }
</style>
