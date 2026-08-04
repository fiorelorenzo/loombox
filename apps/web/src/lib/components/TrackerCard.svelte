<script lang="ts">
  /**
   * One native tracker record's card/row rendering (SPEC §7.10; issue
   * #212). Every value is read through `resolveRoleValue` against the
   * record's OWN type — this component never special-cases a
   * `primaryType`. A built-in Task/Bug/Epic and a project-defined custom
   * type render identically as long as their `roles` mapping resolves the
   * same four roles (issue #212's "no per-type UI code" acceptance).
   *
   * The "Move to" `Select` is the keyboard/menu path issue #212 requires
   * regardless of drag support — it works identically with a mouse,
   * keyboard, or touch, unlike HTML5 drag-and-drop (`TrackerBoard.svelte`'s
   * `draggable`/`ondragstart`, layered on top for a desktop mouse user;
   * see that file's doc comment for why native DnD alone isn't enough).
   * Both paths call the exact same `onMove`, which goes through
   * `RelayClient.updateTrackerRecord` — the real store, never local
   * component state.
   */
  import {
    resolveRoleValue,
    type TrackerRecordV1,
    type TrackerTypeRegistryV1,
  } from '@loombox/protocol';
  import Badge from './ui/Badge.svelte';
  import { type StatusTone } from './ui/StatusDot.svelte';
  import Card from './ui/Card.svelte';
  import Select, { type SelectOption } from './ui/Select.svelte';

  interface Props {
    record: TrackerRecordV1;
    types: TrackerTypeRegistryV1;
    /** Kanban column options this record can move to; omitted in the list view, which has no per-row move control. */
    moveOptions?: SelectOption[];
    onMove?: (id: string, workflowStatus: string) => void;
    onOpen?: (record: TrackerRecordV1) => void;
    draggable?: boolean;
    ondragstart?: (event: DragEvent) => void;
  }

  const {
    record,
    types,
    moveOptions,
    onMove,
    onOpen,
    draggable = false,
    ondragstart,
  }: Props = $props();

  const type = $derived(types.get(record.primaryType));
  const title = $derived.by(() => {
    const value = resolveRoleValue(record, types, 'title');
    return typeof value === 'string' && value.length > 0 ? value : `#${record.issueNumber}`;
  });
  const priority = $derived(resolveRoleValue(record, types, 'priority'));
  const assignee = $derived(resolveRoleValue(record, types, 'assignee'));
  const workflowStatus = $derived(resolveRoleValue(record, types, 'workflowStatus'));

  /** A generic, value-level heuristic (never keyed by `primaryType`) — any type's priority vocabulary maps through the same substring rules. */
  function priorityTone(value: unknown): StatusTone {
    if (typeof value !== 'string') return 'neutral';
    const lower = value.toLowerCase();
    if (lower.includes('urgent') || lower.includes('high') || lower.includes('critical')) {
      return 'danger';
    }
    if (lower.includes('medium') || lower.includes('normal')) return 'warning';
    if (lower.includes('low')) return 'info';
    return 'neutral';
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tracker-card-wrapper"
  {draggable}
  {ondragstart}
  data-testid={`tracker-card-${record.id}`}
>
  <Card elevation="raised" padding="sm" class="tracker-card">
    <button
      type="button"
      class="tracker-card-open"
      onclick={() => onOpen?.(record)}
      data-testid={`tracker-card-open-${record.id}`}
    >
      <span class="tracker-card-title">{title}</span>
    </button>
    <div class="tracker-card-meta">
      {#if type}
        <Badge size="sm" dataTestId="tracker-card-type">{type.label}</Badge>
      {/if}
      {#if typeof priority === 'string' && priority.length > 0}
        <Badge size="sm" tone={priorityTone(priority)} dataTestId="tracker-card-priority"
          >{priority}</Badge
        >
      {/if}
      {#if typeof assignee === 'string' && assignee.length > 0}
        <span class="tracker-card-assignee" data-testid="tracker-card-assignee">{assignee}</span>
      {/if}
    </div>
    {#if moveOptions && moveOptions.length > 0 && onMove}
      <Select
        label={`Move "${title}" to`}
        value={typeof workflowStatus === 'string' ? workflowStatus : ''}
        options={moveOptions}
        size="sm"
        onChange={(next) => onMove(record.id, next)}
        dataTestId={`tracker-card-move-${record.id}`}
      />
    {/if}
  </Card>
</div>

<style>
  :global(.tracker-card) {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .tracker-card-open {
    all: unset;
    cursor: pointer;
    display: block;
    width: 100%;
  }

  .tracker-card-open:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  .tracker-card-title {
    font-weight: var(--text-title-weight);
    color: var(--color-text-primary);
  }

  .tracker-card-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2xs);
  }

  .tracker-card-assignee {
    font-size: var(--text-caption-size);
    color: var(--color-text-secondary);
  }
</style>
