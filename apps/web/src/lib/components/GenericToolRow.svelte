<script lang="ts">
  /**
   * The generic `ToolKind`-driven fallback row (SPEC.md §7.24 tier-2, issue
   * #140) — the guaranteed baseline for any tool call without a bespoke
   * widget (the generic ACP adapter tier has no per-tool-name knowledge at
   * all). `ToolCallRow` is the one place that decides bespoke-vs-generic
   * (`$lib/tool-widgets.ts`'s `resolveToolWidgetKind`), so this component
   * itself never needs to know about the bespoke tier.
   *
   * Warp Deck restyle (docs/design/redesign.md, issue #432): adopts the
   * elevation ladder's "raised" tier (Card's own recipe, hand-styled here
   * rather than imported so the generic-tool-row testid this component's
   * tests query stays on the actual root element).
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): every tool call that lands here (tier-2, no bespoke widget) is by
   * definition the "any other tool" case, so it always draws the shared
   * `tool-generic` glyph — decorative, the `kind-badge` text right next to
   * it already carries the meaning.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import { toolCallOutputText } from '$lib/tool-widgets';
  import CopyButton from './CopyButton.svelte';
  import Icon from './icons/Icon.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();

  const outputText = $derived(toolCallOutputText(item.content ?? item.rawInput));
  const copyText = $derived(`${item.title ?? item.toolKind ?? item.id}\n${outputText}`.trim());
</script>

<div
  class="generic-tool-row"
  data-tool-kind={item.toolKind ?? 'other'}
  data-testid="generic-tool-row"
>
  <div class="row-header">
    <Icon name="tool-generic" class="type-icon" />
    <span class="kind-badge">{item.toolKind ?? 'other'}</span>
    <span class="title">{item.title ?? item.id}</span>
    {#if item.status}<span class="status">{item.status}</span>{/if}
    <CopyButton text={copyText} label={`Copy ${item.title ?? 'tool call'} output`} />
  </div>
  {#if outputText}
    <pre class="output">{outputText}</pre>
  {/if}
</div>

<style>
  /* raised tier (elevation ladder §3). */
  .generic-tool-row {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-sm) 0.7rem;
    font-size: var(--text-small-size);
  }

  .row-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  :global(.type-icon) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .kind-badge {
    text-transform: uppercase;
    font-size: 0.65rem;
    letter-spacing: 0.03em;
    opacity: 0.7;
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    padding: 0.05rem var(--space-2xs);
  }

  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    opacity: 0.6;
    font-size: var(--text-small-size);
  }

  .output {
    margin: var(--space-xs) 0 0;
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-fill-subtle);
    border-radius: var(--radius-md);
    overflow-x: auto;
    white-space: pre-wrap;
    font-size: var(--text-small-size);
    font-family: var(--font-mono);
  }
</style>
