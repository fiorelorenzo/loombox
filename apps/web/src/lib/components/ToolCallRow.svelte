<script lang="ts">
  /**
   * The tool-call dispatcher (SPEC.md §7.24 "Tool calls, two tiers in v1";
   * issues #139/#140): picks the bespoke widget for the handful of tools
   * worth custom rendering, falling back to the generic `ToolKind`-driven
   * row for everything else — and never both at once, including mid-stream
   * before the bespoke widget's first paint (issue #140's acceptance),
   * since `resolveToolWidgetKind` is a single synchronous decision made
   * once per render from the item's current fields, not a two-step
   * "try bespoke, then also render generic" pipeline.
   *
   * Each bespoke widget is wrapped in its own `<svelte:boundary>` (native
   * Svelte 5 error boundary) so a widget that throws while rendering falls
   * back to the generic row instead of taking down the rest of the
   * transcript (issue #139's acceptance, tested by forcing a throw).
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import { resolveToolWidgetKind } from '$lib/tool-widgets';
  import EditWriteWidget from './tool-widgets/EditWriteWidget.svelte';
  import BashWidget from './tool-widgets/BashWidget.svelte';
  import TodoWidget from './tool-widgets/TodoWidget.svelte';
  import GenericToolRow from './GenericToolRow.svelte';

  interface Props {
    item: TranscriptToolCallItem;
    /** True while this tool call's own permission request is the actionable FIFO head (SPEC.md §7.24 nested-visibility hook, issue #146). */
    awaitingPermission?: boolean;
  }

  const { item, awaitingPermission = false }: Props = $props();
  const widgetKind = $derived(resolveToolWidgetKind(item));
  // A bespoke widget that throws falls back to the generic row for this
  // render (`bespokeFailed`); tracked by item id so a fresh item id (a new
  // tool call) always gets a clean attempt at its own bespoke widget.
  let bespokeFailedFor = $state<string | undefined>(undefined);
</script>

<div
  class="tool-call-row"
  class:awaiting-permission={awaitingPermission}
  data-testid="tool-call-row"
>
  {#if widgetKind !== 'generic' && bespokeFailedFor !== item.id}
    <svelte:boundary onerror={() => (bespokeFailedFor = item.id)}>
      {#if widgetKind === 'edit-write'}
        <EditWriteWidget {item} />
      {:else if widgetKind === 'bash'}
        <BashWidget {item} />
      {:else if widgetKind === 'todo'}
        <TodoWidget {item} />
      {/if}
      {#snippet failed()}
        <GenericToolRow {item} />
      {/snippet}
    </svelte:boundary>
  {:else}
    <GenericToolRow {item} />
  {/if}
</div>

<style>
  .tool-call-row.awaiting-permission {
    outline: 2px solid #f59e0b;
    outline-offset: 2px;
    border-radius: 0.5rem;
  }
</style>
