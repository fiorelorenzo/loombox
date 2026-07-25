<script lang="ts">
  /**
   * The bespoke Edit/Write widget (SPEC.md §7.24 tier-1, issue #139):
   * Claude's Edit/Write and Codex's patch/diff all resolve here
   * (`$lib/tool-widgets.ts`'s `resolveToolWidgetKind`) since they share
   * ACP v1's one `Diff` shape. Reuses `DiffViewer` verbatim - the same
   * component the working-tree diff viewer (§7.4) uses - rather than
   * re-rendering the diff itself.
   *
   * Warp Deck restyle (docs/design/redesign.md, issue #432): the widget
   * adopts the elevation ladder's "raised" tier as its outer frame (title +
   * status), with `DiffViewer`'s own card nested inside unchanged.
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): the header draws the shared `tool-edit` glyph next to the title,
   * the same convention `BashWidget`/`TodoWidget` use.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import DiffViewer from '../DiffViewer.svelte';
  import Icon from '../icons/Icon.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();
  // resolveToolWidgetKind only routes here when `diff` is present.
  const diff = $derived(item.diff!);
</script>

<div class="edit-write-widget" data-testid="edit-write-widget">
  <div class="header">
    <Icon name="tool-edit" class="type-icon" />
    <span class="title">{item.title ?? 'Edit'}</span>
    {#if item.status}<span class="status">{item.status}</span>{/if}
  </div>
  <DiffViewer path={diff.path} oldText={diff.oldText} newText={diff.newText} />
</div>

<style>
  /* raised tier (elevation ladder §3): the outer frame for the title row;
     DiffViewer keeps its own nested card treatment. */
  .edit-write-widget {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-sm);
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  :global(.type-icon) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    font-weight: 400;
    opacity: 0.6;
    font-size: var(--text-small-size);
  }
</style>
