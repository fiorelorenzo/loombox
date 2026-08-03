<script lang="ts">
  /**
   * The bespoke Edit/Write widget (SPEC.md §7.24 tier-1, issue #139):
   * Claude's Edit/Write and Codex's patch/diff all resolve here
   * (`$lib/tool-widgets.ts`'s `resolveToolWidgetKind`) since they share
   * ACP v1's one `Diff` shape. Reuses `DiffViewer` verbatim - the same
   * component the working-tree diff viewer (§7.4) uses - rather than
   * re-rendering the diff itself.
   *
   * One level of card chrome (design spec `2026-08-03-cockpit-v6-design.md`
   * §3.4, issue #576): `DiffViewer` keeps its own raised, bordered card
   * unchanged — a diff earns its surface — so `ToolCard` renders `surface=
   * {false}` here rather than wrapping that in a second, redundant bordered
   * frame. The header row (icon, title, status, disclosure) stays plain
   * text directly above it. Status renders via the shared
   * `ToolCallStatus` (a failed edit is louder than a completed one; see
   * that component's own doc comment). The header toggles the diff body's
   * expand/collapse, defaulting open (so a mid-stream/malformed diff still
   * renders — and can still throw into `ToolCallRow`'s error boundary —
   * exactly as before).
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): the header draws the shared `tool-edit` glyph next to the title,
   * the same convention `BashWidget`/`TodoWidget` use.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
  import DiffViewer from '../DiffViewer.svelte';
  import ToolCallGutter from '../ToolCallGutter.svelte';
  import ToolCallStatus from '../ToolCallStatus.svelte';
  import Icon from '../icons/Icon.svelte';
  import ToolCard from './ToolCard.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();
  // resolveToolWidgetKind only routes here when `diff` is present.
  const diff = $derived(item.diff!);

  let expanded = $state(true);
</script>

<div class="edit-write-widget" data-testid="edit-write-widget">
  <ToolCallGutter icon="tool-edit" />
  <ToolCard surface={false}>
    <button
      type="button"
      class="row-header"
      onclick={() => (expanded = !expanded)}
      aria-expanded={expanded}
    >
      <Icon name="collapse-chevron" size="0.7em" class="disclosure-icon" />
      <span class="title">{item.title ?? 'Edit'}</span>
      <ToolCallStatus status={item.status} />
    </button>
    {#if expanded}
      <div class="body">
        <DiffViewer path={diff.path} oldText={diff.oldText} newText={diff.newText} />
      </div>
    {/if}
  </ToolCard>
</div>

<style>
  .edit-write-widget {
    display: flex;
    align-items: flex-start;
    width: 100%;
    min-width: 0;
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

  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .body {
    margin-top: var(--space-xs);
    min-width: 0;
  }

  /* Below `--bp-mobile` the role column collapses, so this row stacks its
     `ToolCallGutter` caption above the card — see that component's own copy
     of this block, and `MessageItem`'s for the measurement. */
  @media (max-width: 479px) {
    .edit-write-widget {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
