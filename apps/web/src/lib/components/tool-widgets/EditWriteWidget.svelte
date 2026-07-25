<script lang="ts">
  /**
   * The bespoke Edit/Write widget (SPEC.md §7.24 tier-1, issue #139):
   * Claude's Edit/Write and Codex's patch/diff all resolve here
   * (`$lib/tool-widgets.ts`'s `resolveToolWidgetKind`) since they share
   * ACP v1's one `Diff` shape. Reuses `DiffViewer` verbatim - the same
   * component the working-tree diff viewer (§7.4) uses - rather than
   * re-rendering the diff itself.
   *
   * Redesign v3 (`docs/superpowers/specs/2026-07-25-redesign-v3-design.md`
   * §3.4 "One tool-call anatomy"): the outer frame is now the same
   * gutter-plus-content row every tool-call widget uses (`GenericToolRow`
   * / `BashWidget` / `TodoWidget`), not its own raised card — `DiffViewer`
   * keeps its own nested card treatment unchanged. Status is a `StatusDot`
   * + short label, never the raw enum. The header toggles the diff body's
   * expand/collapse, defaulting open (so a mid-stream/malformed diff still
   * renders — and can still throw into `ToolCallRow`'s error boundary —
   * exactly as before).
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): the header draws the shared `tool-edit` glyph next to the title,
   * the same convention `BashWidget`/`TodoWidget` use.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import { TOOL_CALL_STATUS_LABELS, TOOL_CALL_STATUS_TONES } from '$lib/tool-widgets';
  import DiffViewer from '../DiffViewer.svelte';
  import Icon from '../icons/Icon.svelte';
  import StatusDot from '../ui/StatusDot.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();
  // resolveToolWidgetKind only routes here when `diff` is present.
  const diff = $derived(item.diff!);

  let expanded = $state(true);
  const statusTone = $derived(item.status ? TOOL_CALL_STATUS_TONES[item.status] : undefined);
  const statusLabel = $derived(item.status ? TOOL_CALL_STATUS_LABELS[item.status] : undefined);
</script>

<div class="edit-write-widget" data-testid="edit-write-widget">
  <div class="gutter" aria-hidden="true">
    <Icon name="tool-edit" class="type-icon" />
  </div>
  <div class="content">
    <button
      type="button"
      class="row-header"
      onclick={() => (expanded = !expanded)}
      aria-expanded={expanded}
    >
      <Icon name="collapse-chevron" size="0.7em" class="disclosure-icon" />
      <span class="title">{item.title ?? 'Edit'}</span>
      {#if statusTone && statusLabel}
        <span class="status">
          <StatusDot tone={statusTone} label={statusLabel} size="sm" />
          <span class="status-label" aria-hidden="true">{statusLabel}</span>
        </span>
      {/if}
    </button>
    {#if expanded}
      <div class="body">
        <DiffViewer path={diff.path} oldText={diff.oldText} newText={diff.newText} />
      </div>
    {/if}
  </div>
</div>

<style>
  .edit-write-widget {
    display: flex;
    align-items: flex-start;
    width: 100%;
    min-width: 0;
  }

  .gutter {
    flex: 0 0 var(--gutter);
    width: var(--gutter);
    display: flex;
    justify-content: center;
    padding-top: var(--space-2xs);
  }

  .content {
    flex: 1;
    min-width: 0;
    padding: var(--space-2xs) 0;
  }

  .row-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  .row-header:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
    border-radius: var(--radius-sm);
  }

  :global(.disclosure-icon) {
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  .row-header[aria-expanded='false'] :global(.disclosure-icon) {
    transform: rotate(-90deg);
  }

  :global(.type-icon) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    flex-shrink: 0;
    font-weight: 400;
  }

  .status-label {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .body {
    margin-top: var(--space-xs);
    min-width: 0;
  }
</style>
