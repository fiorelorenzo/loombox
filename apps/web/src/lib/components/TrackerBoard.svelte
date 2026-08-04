<script lang="ts">
  /**
   * The kanban board (SPEC §7.10; issue #212, restructured by issue #651 /
   * v7 decision F4-2). Columns are the three fixed workflow categories
   * every board reads at a glance — never one column per raw status. A
   * tracker's own workflow (Jira's `statusCategory`, GitHub's
   * `open`/`closed` + `state_reason`, loombox's own local status
   * vocabulary — see `@loombox/protocol`'s `resolveWorkflowCategory` doc
   * comment) collapses into `groupByWorkflowCategory`, which always
   * returns all three columns in workflow order, even when a category has
   * no records — an empty category still renders and still accepts a
   * drop, fixing the old per-status `groupByWorkflowStatus`'s twin defect
   * (a status nobody used yet never appeared as a column at all, and
   * alphabetical sort put "Done" ahead of "In progress"/"Todo").
   *
   * Fixing the column count at three, rather than deriving it from the
   * data, is also what keeps this fitting a laptop width with no
   * horizontal scroller: three `18rem` columns plus two `--space-md`
   * gaps is 888px, comfortably under any real laptop viewport — where
   * the old alphabetical board could grow to as many columns as a
   * project's workflow had raw statuses (six, in the review that flagged
   * this: 1778px of content in a 1080px container).
   *
   * Drag-and-drop is a desktop-mouse enhancement layered on top of, never
   * instead of, a fully keyboard/touch-operable path: native HTML5 DnD
   * (`draggable`/`dragstart`/`dragover`/`drop`) has no touch equivalent
   * without a separate polyfill (out of scope here), so `TrackerCard`'s own
   * "Move to" `Select` is the real accessibility contract — both paths call
   * the identical `onMove`, which goes through `RelayClient.updateTrackerRecord`
   * (the real store), never local component state. Both paths write the
   * literal category id (`new`/`indeterminate`/`done`) back as the
   * record's new `workflowStatus` value; `resolveWorkflowCategory`'s own
   * doc comment is why that always resolves back into the same column.
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
    groupByWorkflowCategory,
    WORKFLOW_CATEGORY_COLUMNS_V1,
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

  /** The three fixed columns, in workflow order — never derived from which statuses `records` happens to use. */
  const columns = WORKFLOW_CATEGORY_COLUMNS_V1;
  const groups = $derived(groupByWorkflowCategory(records, types));
  const moveOptions = $derived<SelectOption[]>(
    columns.map((column) => ({ id: column.id, label: column.label })),
  );

  // `columns.length` is a fixed 3, so a bounds clamp on mount/update (the
  // old data-derived-column-count version needed one) can't be reached —
  // `disabled` on the Prev/Next buttons below is the only guard needed.
  let mobileColumnIndex = $state(0);

  const draggedIds = new SvelteSet<string>();

  function handleDragStart(id: string) {
    return (event: DragEvent) => {
      draggedIds.add(id);
      event.dataTransfer?.setData('text/plain', id);
      event.dataTransfer?.setData('application/x-loombox-tracker-record', id);
    };
  }

  function handleDrop(categoryId: string) {
    return (event: DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer?.getData('application/x-loombox-tracker-record');
      if (id) {
        onMove(id, categoryId);
        draggedIds.delete(id);
      }
    };
  }

  function handleDragOver(event: DragEvent): void {
    event.preventDefault();
  }
</script>

<div class="tracker-board" data-testid="tracker-board">
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
      {columns[mobileColumnIndex]?.label}
      <span class="tracker-board-column-count"
        >{groups.get(columns[mobileColumnIndex]?.id ?? 'new')?.length ?? 0}</span
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
    {#each columns as column, index (column.id)}
      <section
        class="tracker-board-column"
        class:tracker-board-column-mobile-hidden={index !== mobileColumnIndex}
        aria-label={column.label}
        ondragover={handleDragOver}
        ondrop={handleDrop(column.id)}
        data-testid={`tracker-board-column-${column.id}`}
      >
        <h3 class="tracker-board-column-title">
          {column.label}
          <span class="tracker-board-column-count">{groups.get(column.id)?.length ?? 0}</span>
        </h3>
        <div class="tracker-board-column-cards">
          {#each groups.get(column.id) ?? [] as record (record.id)}
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
</div>

<style>
  .tracker-board {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }

  /* Desktop/tablet default: every column side by side. `overflow-x: auto`
     is defensive, not load-bearing — three fixed `18rem` columns plus two
     `--space-md` gaps is 888px, which fits without scrolling at any real
     laptop width (issue #651 / v7 decision F4-2's "no horizontal
     scroller" acceptance); this only kicks in if a future column's own
     content ever forced it wider. */
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
