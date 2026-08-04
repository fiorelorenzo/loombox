<script lang="ts">
  /**
   * The native tracker's client surface (SPEC §7.10; issue #212): a kanban
   * board and a priority-sorted/assignee-filtered list over the SAME
   * `TrackerRecordV1[]`/`TrackerTypeDefinitionV1[]` snapshot, both reading
   * every value through `@loombox/protocol`'s role-driven helpers — a
   * built-in Task/Bug/Epic and a project-defined custom type render
   * identically, with no per-type UI code anywhere in this feature.
   *
   * A full-width page (`PageLayout`, reached from the left sidebar,
   * `+page.svelte`'s `mainView === 'tracker'`), not a right-sidebar
   * sub-tab: `docs/superpowers/specs/2026-08-03-cockpit-v6-design.md` caps
   * that sidebar at `min(26rem, 90vw)` (§3.1's zone diagram), which a
   * multi-column kanban board cannot usably render in — Files/Config stay
   * there because each is a single scrollable list/form, never several
   * side-by-side columns. `PageLayout`'s own "you leave a page by going
   * somewhere else" contract (that primitive's doc comment) is exactly the
   * right model for a page you work IN for a while, the same reason
   * Inbox/Settings are pages rather than panels.
   *
   * `client` is a narrow slice of `RelayClient` (mirrors
   * `InteractiveTerminal`'s own `TerminalClient`), so a component test
   * injects a plain fake with no crypto/WebSocket machinery — this
   * component subscribes to it directly (`onMount`/`onDestroy`, same
   * shape as `InteractiveTerminal.terminalsFor`), rather than taking an
   * already-subscribed value as a prop, since it owns its own bounded-wait
   * timeout (issue #582; see `TIMEOUT_MS` below) the same way that
   * component owns its own `OPEN_TIMEOUT_MS`.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import type { Readable } from 'svelte/store';
  import {
    buildTrackerTypeRegistryV1,
    type TrackerRecordV1,
    type TrackerRoleV1,
    type TrackerTypeDefinitionV1,
  } from '@loombox/protocol';
  import type { TrackerSnapshotState } from '$lib/relay-client';
  import { Icon, type IconName } from '../icons';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import ErrorNotice from '../ui/ErrorNotice.svelte';
  import WovenLoader from '../WovenLoader.svelte';
  import TrackerBoard from '../TrackerBoard.svelte';
  import TrackerListView from '../TrackerListView.svelte';
  import TrackerRecordDialog, { type TrackerRecordClient } from '../TrackerRecordDialog.svelte';
  import TrackerManageTypesDialog, {
    type TrackerTypeClient,
  } from '../TrackerManageTypesDialog.svelte';
  import PageLayout from './PageLayout.svelte';

  /** Mirrors `RelayClient`'s own tracker methods field-for-field (every write takes `sessionId` as its first argument, matching `RelayClient.createTrackerRecord`/`updateTrackerRecord`/`defineTrackerType`'s real signatures) — {@link dialogClient} below adapts this into the session-free shape `TrackerRecordDialog`/`TrackerManageTypesDialog` expect. */
  export interface TrackerPageClient {
    trackerSnapshotFor: (sessionId: string) => Readable<TrackerSnapshotState>;
    reloadTrackerSnapshot: (sessionId: string) => void;
    createTrackerRecord: (
      sessionId: string,
      input: { primaryType: string; typeTags?: string[]; fields: Record<string, unknown> },
    ) => Promise<TrackerRecordV1>;
    updateTrackerRecord: (
      sessionId: string,
      id: string,
      patch: {
        primaryType?: string;
        typeTags?: string[];
        fields?: Record<string, unknown>;
        archived?: boolean;
      },
    ) => Promise<TrackerRecordV1>;
    defineTrackerType: (
      sessionId: string,
      type: { id: string; label: string; roles: Partial<Record<TrackerRoleV1, string>> },
    ) => Promise<TrackerTypeDefinitionV1>;
  }

  interface Props {
    client: TrackerPageClient;
    sessionId: string;
  }

  const { client, sessionId }: Props = $props();

  type ViewMode = 'kanban' | 'list';
  const VIEWS: { id: ViewMode; label: string; icon: IconName }[] = [
    { id: 'kanban', label: 'Board', icon: 'tracker' },
    { id: 'list', label: 'List', icon: 'sessions' },
  ];
  let viewMode = $state<ViewMode>('kanban');
  let viewTabsEl = $state<HTMLDivElement | undefined>(undefined);

  function handleViewKeydown(event: KeyboardEvent): void {
    let delta: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        delta = 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        delta = -1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const currentIndex = VIEWS.findIndex((view) => view.id === viewMode);
    const nextIndex = (Math.max(currentIndex, 0) + delta + VIEWS.length) % VIEWS.length;
    const nextView = VIEWS[nextIndex];
    if (!nextView) return;
    viewMode = nextView.id;
    tick().then(() => {
      const radios = viewTabsEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      radios?.[nextIndex]?.focus();
    });
  }

  let snapshot = $state<TrackerSnapshotState>({ status: 'loading', records: [], types: [] });
  let timedOut = $state(false);
  let unsubscribe: (() => void) | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  /** How long the initial/a reloaded snapshot may sit `'loading'` before this page gives up waiting on its own (issue #582) — `TrackerSnapshotState` carries no timeout of its own. 10s matches every other request-shaped `RelayClient` default (`FileTreePanel`'s `DIRECTORY_TIMEOUT_MS`, `InteractiveTerminal`'s `OPEN_TIMEOUT_MS`). */
  const TIMEOUT_MS = 10_000;

  function clearBoundedWait(): void {
    if (timeoutHandle === undefined) return;
    clearTimeout(timeoutHandle);
    timeoutHandle = undefined;
  }

  function armBoundedWait(): void {
    clearBoundedWait();
    timeoutHandle = setTimeout(() => {
      timeoutHandle = undefined;
      timedOut = true;
    }, TIMEOUT_MS);
  }

  function subscribe(): void {
    unsubscribe?.();
    unsubscribe = client.trackerSnapshotFor(sessionId).subscribe((value) => {
      snapshot = value;
      if (value.status === 'loading') {
        if (timeoutHandle === undefined && !timedOut) armBoundedWait();
      } else {
        // A real answer, however late, is the honest resolution of this
        // page's own bounded wait (mirrors `InteractiveTerminal`'s
        // identical "a late real answer still lands" contract).
        clearBoundedWait();
        timedOut = false;
      }
    });
  }

  onMount(subscribe);
  onDestroy(() => {
    unsubscribe?.();
    clearBoundedWait();
  });

  // Re-subscribes if the caller ever points this page at a different
  // session (a mount-time-only `onMount` would keep listening to the OLD
  // session's store forever otherwise).
  $effect(() => {
    void sessionId;
    subscribe();
    timedOut = false;
  });

  function retry(): void {
    timedOut = false;
    client.reloadTrackerSnapshot(sessionId);
  }

  const registry = $derived(buildTrackerTypeRegistryV1(snapshot.types));

  /** Adapts {@link client} into the session-free shape `TrackerRecordDialog`/`TrackerManageTypesDialog` expect (both mirror `AddProjectDialog`'s established "a dialog calls its own narrow client directly" convention) — binds `sessionId` once here rather than threading it through every dialog prop. */
  const dialogClient = $derived<TrackerRecordClient & TrackerTypeClient>({
    createTrackerRecord: (input) => client.createTrackerRecord(sessionId, input),
    updateTrackerRecord: (id, patch) => client.updateTrackerRecord(sessionId, id, patch),
    defineTrackerType: (type) => client.defineTrackerType(sessionId, type),
  });

  let recordDialogOpen = $state(false);
  let editingRecord = $state<TrackerRecordV1 | undefined>(undefined);
  let manageTypesDialogOpen = $state(false);

  function openCreateDialog(): void {
    editingRecord = undefined;
    recordDialogOpen = true;
  }

  function openEditDialog(record: TrackerRecordV1): void {
    editingRecord = record;
    recordDialogOpen = true;
  }

  function closeRecordDialog(): void {
    recordDialogOpen = false;
  }

  /** The kanban board's/list's own generic move: resolves the moved record's OWN type's `workflowStatus` field key (never a hardcoded one) and patches just that field — goes through `RelayClient.updateTrackerRecord`, the real store. */
  function handleMove(id: string, workflowStatus: string): void {
    const record = snapshot.records.find((candidate) => candidate.id === id);
    if (!record) return;
    const type = registry.get(record.primaryType);
    const key = type?.roles.workflowStatus;
    if (!key) return;
    void client.updateTrackerRecord(sessionId, id, {
      fields: { ...record.fields, [key]: workflowStatus },
    });
  }
</script>

{#snippet actions()}
  <Button variant="secondary" size="sm" onclick={() => (manageTypesDialogOpen = true)}>
    Manage types
  </Button>
  <Button variant="primary" size="sm" onclick={openCreateDialog}>New record</Button>
{/snippet}

<PageLayout title="Tracker" testid="tracker-page" {actions}>
  {#if snapshot.status === 'error' || timedOut}
    <ErrorNotice
      message={timedOut
        ? "This project's tracker didn't answer in time. The node may be asleep, offline, or on an older relay."
        : (snapshot.error ?? 'Failed to load the tracker.')}
      retryable
      onRetry={retry}
    />
  {:else if snapshot.status === 'loading'}
    <p class="tracker-page-loading" data-testid="tracker-page-loading">
      <WovenLoader size="sm" label="Loading tracker" />
      Loading…
    </p>
  {:else if snapshot.records.length === 0}
    <EmptyState message="This project has no tracker records yet.">
      {#snippet cta()}
        <Button variant="primary" onclick={openCreateDialog}>New record</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <div
      class="tracker-page-view-tabs"
      role="radiogroup"
      aria-label="Tracker view"
      bind:this={viewTabsEl}
    >
      {#each VIEWS as view (view.id)}
        <Button
          variant="ghost"
          size="sm"
          class={`tracker-page-view-tab ${viewMode === view.id ? 'selected' : ''}`.trim()}
          role="radio"
          ariaChecked={viewMode === view.id}
          tabindex={viewMode === view.id ? 0 : -1}
          ariaLabel={view.label}
          onclick={() => (viewMode = view.id)}
          onkeydown={handleViewKeydown}
          dataTestId={`tracker-view-${view.id}`}
        >
          <Icon name={view.icon} />
          {view.label}
        </Button>
      {/each}
    </div>

    {#if viewMode === 'kanban'}
      <TrackerBoard
        records={snapshot.records}
        types={registry}
        onMove={handleMove}
        onOpen={openEditDialog}
      />
    {:else}
      <TrackerListView records={snapshot.records} types={registry} onOpen={openEditDialog} />
    {/if}
  {/if}
</PageLayout>

<TrackerRecordDialog
  open={recordDialogOpen}
  client={dialogClient}
  types={snapshot.types}
  record={editingRecord}
  onClose={closeRecordDialog}
  onSaved={() => {}}
/>

<TrackerManageTypesDialog
  open={manageTypesDialogOpen}
  client={dialogClient}
  types={snapshot.types}
  onClose={() => (manageTypesDialogOpen = false)}
  onDefined={() => {}}
/>

<style>
  .tracker-page-loading {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    color: var(--color-text-secondary);
  }

  .tracker-page-view-tabs {
    display: flex;
    gap: var(--space-2xs);
    margin-bottom: var(--space-md);
  }

  :global(.tracker-page-view-tab.selected) {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
  }
</style>
