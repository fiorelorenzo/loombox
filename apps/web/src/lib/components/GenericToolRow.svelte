<script lang="ts">
  /**
   * The generic `ToolKind`-driven fallback row (SPEC.md §7.24 tier-2, issue
   * #140) — the guaranteed baseline for any tool call without a bespoke
   * widget (the generic ACP adapter tier has no per-tool-name knowledge at
   * all). `ToolCallRow` is the one place that decides bespoke-vs-generic
   * (`$lib/tool-widgets.ts`'s `resolveToolWidgetKind`), so this component
   * itself never needs to know about the bespoke tier.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import { toolCallOutputText } from '$lib/tool-widgets';
  import CopyButton from './CopyButton.svelte';

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
  .generic-tool-row {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-sm) 0.7rem;
    font-size: var(--text-small-size);
  }

  .row-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .kind-badge {
    text-transform: uppercase;
    font-size: 0.65rem;
    letter-spacing: 0.03em;
    opacity: 0.6;
    border: 1px solid currentColor;
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
