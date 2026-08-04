<script lang="ts">
  /**
   * The kanban board (SPEC §7.10; issue #212): columns are derived from
   * every distinct `workflowStatus` role value currently present across
   * `records`, via `@loombox/protocol`'s `groupByWorkflowStatus` — never a
   * hardcoded status list, so a built-in Task/Bug/Epic and a
   * project-defined custom type render into the same columns as long as
   * they map a `workflowStatus` role (issue #212's "no per-type UI code").
   *
   * Drag-and-drop is a desktop-mouse enhancement layered on top of, never
   * instead of, a fully keyboard/touch-operable path: native HTML5 DnD
   * (`draggable`/`dragstart`/`dragover`/`drop`) has no touch equivalent
   * without a separate polyfill (out of scope here), so `TrackerCard`'s own
   * "Move to" `Select` is the real accessibility contract — both paths call
   * the identical `onMove`, which goes through `RelayClient.updateTrackerRecord`
   * (the real store), never local component state.
   *
   * Mobile (<=767px): a kanban board with several columns has no usable
   * answer as a horizontal scroll on a 390px viewport (issue #212's
   * explicit acceptance) — below that breakpoint this renders ONE column
   * at a time with Prev/Next controls plus the current column's name and
   * count, the same "one thing at a time, swipeable" shape the terminal/
   * right-sidebar docks already use below 1024px (design spec
   * `2026-08-03-cockpit-v6-design.md` §3.3). A modal bottom sheet (the
   * <=767px pattern those docks use for TRANSIENT overlay content) would
   * be the wrong fit here: the board is this page's primary, persistent
   * content, not a toggleable panel.
   */
  import { SvelteSet } from 'svelte/reactivity';
  import {
    groupByWorkflowStatus,
    UNRESOLVED_WORKFLOW_STATUS,
    type TrackerRecordV1,
    type TrackerTypeRegistryV1,
  } from '@loombox/protocol';
  import Button from './ui/Button.svelte';
  import { Icon } from './icons';
  import TrackerCard from './TrackerCard.svelte';
  import type { SelectOption } from './ui/Select.svelte';

  interface Props {
    records: TrackerRecordV1[];
    types: TrackerTypeRegistryV1;
    onMove: (id: string, workflowStatus: string) => void;
    onOpen: (record: TrackerRecordV1) => void;
  }

  const { records, types, onMove, onOpen }: Props = $props();

  const groups = $derived(groupByWorkflowStatus(records, types));
  /** Every distinct column, alphabetical, with the "no resolvable status" bucket always last — a stable, generic order that never depends on a project's own status vocabulary. */
  const columns = $derived.by(() => {
    const keys = [...groups.keys()].filter((key) => key !== UNRESOLVED_WORKFLOW_STATUS).sort();
    if (groups.has(UNRESOLVED_WORKFLOW_STATUS)) keys.push(UNRESOLVED_WORKFLOW_STATUS);
    return keys;
  });
  const moveOptions = $derived<SelectOption[]>(
    columns.map((column) => ({ id: column, label: column })),
  );

  let mobileColumnIndex = $state(0);
  $effect(() => {
    if (mobileColumnIndex > 0 && mobileColumnIndex >= columns.length) {
      mobileColumnIndex = Math.max(0, columns.length - 1);
    }
  });

  const draggedIds = new SvelteSet<string>();

  function handleDragStart(id: string) {
    return (event: DragEvent) => {
      draggedIds.add(id);
      event.dataTransfer?.setData('text/plain', id);
      event.dataTransfer?.setData('application/x-loombox-tracker-record', id);
    };
  }

  function handleDrop(column: string) {
    return (event: DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer?.getData('application/x-loombox-tracker-record');
      if (id) {
        onMove(id, column);
        draggedIds.delete(id);
      }
    };
  }

  function handleDragOver(event: DragEvent): void {
    event.preventDefault();
  }
</script>

<div class="tracker-board" data-testid="tracker-board">
  {#if columns.length === 0}
    <p class="tracker-board-empty" data-testid="tracker-board-empty">
      No records have a resolvable status yet.
    </p>
  {:else}
    <div class="tracker-board-mobile-nav" data-testid="tracker-board-mobile-nav">
      <Button
        variant="ghost"
        size="sm"
        ariaLabel="Previous column"
        disabled={mobileColumnIndex === 0}
        onclick={() => (mobileColumnIndex = Math.max(0, mobileColumnIndex - 1))}
      >
        <Icon
          name="chevron-down"
          class="tracker-board-mobile-nav-icon tracker-board-mobile-nav-icon-prev"
        />
      </Button>
      <span class="tracker-board-mobile-title" data-testid="tracker-board-mobile-title">
        {columns[mobileColumnIndex]}
        <span class="tracker-board-column-count"
          >{groups.get(columns[mobileColumnIndex] ?? '')?.length ?? 0}</span
        >
      </span>
      <Button
        variant="ghost"
        size="sm"
        ariaLabel="Next column"
        disabled={mobileColumnIndex >= columns.length - 1}
        onclick={() => (mobileColumnIndex = Math.min(columns.length - 1, mobileColumnIndex + 1))}
      >
        <Icon name="chevron-down" class="tracker-board-mobile-nav-icon" />
      </Button>
    </div>

    <div class="tracker-board-columns" data-testid="tracker-board-columns">
      {#each columns as column, index (column)}
        <section
          class="tracker-board-column"
          class:tracker-board-column-mobile-hidden={index !== mobileColumnIndex}
          aria-label={column}
          ondragover={handleDragOver}
          ondrop={handleDrop(column)}
          data-testid={`tracker-board-column-${column}`}
        >
          <h3 class="tracker-board-column-title">
            {column}
            <span class="tracker-board-column-count">{groups.get(column)?.length ?? 0}</span>
          </h3>
          <div class="tracker-board-column-cards">
            {#each groups.get(column) ?? [] as record (record.id)}
              <TrackerCard
                {record}
                {types}
                {moveOptions}
                {onMove}
                {onOpen}
                draggable
                ondragstart={handleDragStart(record.id)}
              />
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tracker-board {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }

  .tracker-board-empty {
    margin: 0;
    color: var(--color-text-secondary);
  }

  /* Desktop/tablet default: every column side by side, the board itself
     scrolling horizontally if there are more columns than fit — normal
     kanban UX above the mobile breakpoint (issue #212's own scoping: the
     390px constraint is specifically about NOT relying on this). */
  .tracker-board-mobile-nav {
    display: none;
  }

  .tracker-board-columns {
    display: flex;
    gap: var(--space-md);
    overflow-x: auto;
    padding-bottom: var(--space-2xs);
  }

  .tracker-board-column {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    flex: 0 0 18rem;
    min-width: 0;
  }

  .tracker-board-column-title {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    margin: 0;
    font-size: var(--text-caption-size);
    letter-spacing: var(--text-caption-tracking);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  .tracker-board-column-count {
    color: var(--color-text-muted);
    font-weight: 400;
  }

  .tracker-board-column-cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    min-height: 2rem;
  }

  /* `Icon`'s `class` prop lands on the `<svg>` it renders inside its own
     component scope, not this one — `:global()` is the same escape hatch
     `Card.svelte`'s own doc comment documents for `EmptyState`'s
     `BrandMark` class. */
  :global(.tracker-board-mobile-nav-icon) {
    transform: rotate(90deg);
  }

  :global(.tracker-board-mobile-nav-icon-prev) {
    transform: rotate(-90deg);
  }

  /* Mobile (issue #212's explicit acceptance): one column at a time, never
     a horizontal scroll of narrow columns. */
  @media (max-width: 767px) {
    .tracker-board-mobile-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm);
    }

    .tracker-board-mobile-title {
      display: flex;
      align-items: center;
      gap: var(--space-2xs);
      font-size: var(--text-caption-size);
      letter-spacing: var(--text-caption-tracking);
      text-transform: uppercase;
      color: var(--color-text-secondary);
    }

    .tracker-board-columns {
      overflow-x: visible;
    }

    .tracker-board-column {
      flex: 1 1 100%;
    }

    .tracker-board-column-mobile-hidden {
      display: none;
    }
  }
</style>
