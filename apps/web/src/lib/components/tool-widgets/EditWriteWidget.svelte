<script lang="ts">
  /**
   * The bespoke Edit/Write widget (SPEC.md §7.24 tier-1, issue #139):
   * Claude's Edit/Write and Codex's patch/diff all resolve here
   * (`$lib/tool-widgets.ts`'s `resolveToolWidgetKind`) since they share
   * ACP v1's one `Diff` shape. Reuses `DiffViewer` verbatim — the same
   * component the working-tree diff viewer (§7.4) uses — rather than
   * re-rendering the diff itself.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import DiffViewer from '../DiffViewer.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();
  // resolveToolWidgetKind only routes here when `diff` is present.
  const diff = $derived(item.diff!);
</script>

<div class="edit-write-widget" data-testid="edit-write-widget">
  <div class="header">
    <span class="title">{item.title ?? 'Edit'}</span>
    {#if item.status}<span class="status">{item.status}</span>{/if}
  </div>
  <DiffViewer path={diff.path} oldText={diff.oldText} newText={diff.newText} />
</div>

<style>
  .edit-write-widget {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .status {
    font-weight: 400;
    opacity: 0.6;
    font-size: 0.75rem;
  }
</style>
