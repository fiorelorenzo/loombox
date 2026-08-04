<script lang="ts">
  /**
   * The list view (SPEC §7.10; issue #212): priority-sorted, optionally
   * filtered by assignee, for a built-in or a project-defined custom type
   * alike — both the sort (`sortByPriority`) and the filter
   * (`filterByAssignee`) come straight from `@loombox/protocol`'s
   * role-driven helpers, reading through each record's OWN type, never a
   * hardcoded `fields.priority`/`fields.assignee` key.
   *
   * Neither `TrackerTypeDefinition` nor `TrackerRecord` declares an
   * authoritative priority vocabulary anywhere (SPEC §7.10 leaves it a
   * free string) — `priorityOrder` below computes one FROM the data,
   * pulling any of a conventional urgent/high/medium/low set to the front
   * (if present) and appending every other distinct value alphabetically.
   * That is a generic, value-level default, not a per-type rule: it
   * behaves identically for any type whose priority values happen to use
   * that vocabulary, and degrades to a plain alphabetical order for one
   * that doesn't.
   */
  import { SvelteSet } from 'svelte/reactivity';
  import { filterByAssignee, resolveRoleValue, sortByPriority } from '@loombox/protocol';
  import type { TrackerRecordV1, TrackerTypeRegistryV1 } from '@loombox/protocol';
  import Badge from './ui/Badge.svelte';
  import Row from './ui/Row.svelte';
  import Select, { type SelectOption } from './ui/Select.svelte';

  interface Props {
    records: TrackerRecordV1[];
    types: TrackerTypeRegistryV1;
    onOpen: (record: TrackerRecordV1) => void;
  }

  const { records, types, onOpen }: Props = $props();

  const CONVENTIONAL_PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'];

  const priorityOrder = $derived.by(() => {
    const distinct = new SvelteSet<string>();
    for (const record of records) {
      const value = resolveRoleValue(record, types, 'priority');
      if (typeof value === 'string' && value.length > 0) distinct.add(value.toLowerCase());
    }
    const known = CONVENTIONAL_PRIORITY_ORDER.filter((value) => distinct.has(value));
    const rest = [...distinct].filter((value) => !known.includes(value)).sort();
    return [...known, ...rest];
  });

  const assigneeOptions = $derived.by((): SelectOption[] => {
    const distinct = new SvelteSet<string>();
    for (const record of records) {
      const value = resolveRoleValue(record, types, 'assignee');
      if (typeof value === 'string' && value.length > 0) distinct.add(value);
    }
    return [
      { id: '', label: 'All assignees' },
      ...[...distinct].sort().map((assignee) => ({ id: assignee, label: assignee })),
    ];
  });

  let assigneeFilter = $state('');

  const filtered = $derived(
    assigneeFilter ? filterByAssignee(records, types, assigneeFilter) : records,
  );
  const sorted = $derived(sortByPriority(filtered, types, priorityOrder));
</script>

<div class="tracker-list" data-testid="tracker-list">
  <div class="tracker-list-filters">
    <Select
      label="Filter by assignee"
      value={assigneeFilter}
      options={assigneeOptions}
      size="sm"
      onChange={(id) => (assigneeFilter = id)}
      dataTestId="tracker-list-assignee-filter"
    />
  </div>

  {#if sorted.length === 0}
    <p class="tracker-list-empty" data-testid="tracker-list-empty">No records match this filter.</p>
  {:else}
    <ul class="tracker-list-rows">
      {#each sorted as record (record.id)}
        {@const type = types.get(record.primaryType)}
        {@const title = resolveRoleValue(record, types, 'title')}
        {@const priority = resolveRoleValue(record, types, 'priority')}
        {@const assignee = resolveRoleValue(record, types, 'assignee')}
        {@const workflowStatus = resolveRoleValue(record, types, 'workflowStatus')}
        <li>
          <Row
            as="button"
            onclick={() => onOpen(record)}
            dataTestId={`tracker-list-row-${record.id}`}
          >
            {#snippet leading()}
              {#if type}
                <Badge size="sm">{type.label}</Badge>
              {/if}
            {/snippet}
            <span class="tracker-list-row-title"
              >{typeof title === 'string' && title.length > 0
                ? title
                : `#${record.issueNumber}`}</span
            >
            {#if typeof workflowStatus === 'string' && workflowStatus.length > 0}
              <span class="tracker-list-row-status">{workflowStatus}</span>
            {/if}
            {#snippet trailing()}
              <span class="tracker-list-row-trailing">
                {#if typeof priority === 'string' && priority.length > 0}
                  <Badge size="sm" tone="neutral">{priority}</Badge>
                {/if}
                {#if typeof assignee === 'string' && assignee.length > 0}
                  <span class="tracker-list-row-assignee">{assignee}</span>
                {/if}
              </span>
            {/snippet}
          </Row>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tracker-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }

  .tracker-list-filters {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .tracker-list-empty {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .tracker-list-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .tracker-list-row-title {
    color: var(--color-text-primary);
  }

  .tracker-list-row-status {
    margin-left: var(--space-sm);
    font-size: var(--text-caption-size);
    color: var(--color-text-secondary);
  }

  .tracker-list-row-trailing {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
  }

  .tracker-list-row-assignee {
    font-size: var(--text-caption-size);
    color: var(--color-text-secondary);
  }
</style>
