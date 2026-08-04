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
   *
   * F1-1/F2-2 (issue #672; spec §6) folded the per-project `TrackerMode`
   * picker into this page, reading `tracker-mode-store.ts` (#209) directly
   * (`trackerModeStorage`/`trackerMode` below) so this page can branch on
   * it — `Config`'s old Tracker section is deleted outright, not mirrored
   * (F2-1 was not picked), so this is now the ONLY place a project's
   * tracker mode is shown or changed. No mode saved yet: the page's own
   * empty state stops being blank and becomes `TrackerConfigPanel`'s own
   * setup form, rendered inline (F1-1) — the exact surface issue #220
   * already built, just relocated. A mode already saved: the header's
   * `actions` cluster gets a compact "what is this / change what this is"
   * control instead (F2-2), the same `TrackerConfigPanel` in its
   * `presentation="header"` shape (a `Dialog`, not an inline form — a
   * page-header bar has no room to grow one). `accountConnect` threads
   * this page's own already-known `nodeId` (the session's own node, so
   * unlike Settings' accounts section there is no node to pick) into that
   * panel's "Connect GitHub"/"Connect Jira" empty-state CTA.
   *
   * **The #631 gap, stated explicitly rather than shipped silently**:
   * `NodeDaemon.readTrackerSnapshotForBridge`
   * (`packages/node/src/node-daemon.ts:2876-2891`) reads the local native
   * store unconditionally and never consults `TrackerMode` — a project
   * switched to `live` still shows local records, with no error. This
   * issue does not wait on #631 (a node-side fix, out of scope for a
   * client surface issue) and ships the picker anyway: {@link
   * trackerMode} is real, persisted, and drives the header/empty-state
   * correctly, but the record data below it does not yet follow a `live`
   * choice. Rather than let that "look like it works and not" silently
   * (this file's own issue explicitly forbids that), `.tracker-live-gap-
   * note` renders whenever `trackerMode.kind === 'live'` and a snapshot has
   * actually loaded, naming #631 directly instead of pretending the synced
   * board is real.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import type { Readable } from 'svelte/store';
  import type { ConnectedAccount, TrackerMode } from '@loombox/protocol';
  import {
    buildTrackerTypeRegistryV1,
    type TrackerRecordV1,
    type TrackerRoleV1,
    type TrackerTypeDefinitionV1,
  } from '@loombox/protocol';
  import type { TrackerSnapshotState } from '$lib/relay-client';
  import { createLocalStorageTrackerModeStorage } from '$lib/tracker-mode-store';
  import { Icon, type IconName } from '../icons';
  import type { GithubConnectClient } from '../GithubConnectFlow.svelte';
  import type { JiraConnectClient } from '../JiraConnectForm.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import ErrorNotice from '../ui/ErrorNotice.svelte';
  import Badge from '../ui/Badge.svelte';
  import WovenLoader from '../WovenLoader.svelte';
  import TrackerBoard from '../TrackerBoard.svelte';
  import TrackerConfigPanel, { type AccountConnectCapability } from '../TrackerConfigPanel.svelte';
  import TrackerListView from '../TrackerListView.svelte';
  import TrackerRecordDialog, { type TrackerRecordClient } from '../TrackerRecordDialog.svelte';
  import TrackerManageTypesDialog, {
    type TrackerTypeClient,
  } from '../TrackerManageTypesDialog.svelte';
  import PageLayout from './PageLayout.svelte';

  /** Mirrors `RelayClient`'s own tracker methods field-for-field (every write takes `sessionId` as its first argument, matching `RelayClient.createTrackerRecord`/`updateTrackerRecord`/`defineTrackerType`'s real signatures) — {@link dialogClient} below adapts this into the session-free shape `TrackerRecordDialog`/`TrackerManageTypesDialog` expect. Also extends `GithubConnectClient`/`JiraConnectClient` and carries `refreshConnectedAccounts` (issue #672): `RelayClient` already implements all three (issue #230/#221), and this page's own `accountConnect` prop to `TrackerConfigPanel` needs exactly that surface — see the file doc comment. */
  export interface TrackerPageClient extends GithubConnectClient, JiraConnectClient {
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
    refreshConnectedAccounts: () => void;
  }

  interface Props {
    client: TrackerPageClient;
    sessionId: string;
    /** Keys `tracker-mode-store.ts`'s storage, same as `ProjectConfigPanel`'s old `projectPath` prop did. */
    projectPath: string;
    /** The session's own node (SPEC §7.26's node-locality) — the node a fresh GitHub/Jira connect from this page's header/empty-state runs on. `undefined` degrades to `GithubConnectFlow`/`JiraConnectForm`'s own "select a node" message rather than hiding the connect buttons. */
    nodeId: string | undefined;
    /** `RelayClient.connectedAccounts`'s latest snapshot — forwarded straight to `TrackerConfigPanel`, same "this page fetches nothing of its own" split every prop here already follows. */
    connectedAccounts?: readonly ConnectedAccount[];
  }

  const { client, sessionId, projectPath, nodeId, connectedAccounts = [] }: Props = $props();

  /** This project's saved tracker mode (issue #672) — `undefined` means never chosen, which is what puts this page into its own setup state (F1-1) instead of the board/list. `trackerModeStorage` is `$derived` off `projectPath` (a different project has its own storage key entirely, same `TrackerModeStorage` shape `TrackerConfigPanel`'s own default construction uses). `trackerMode` is a writable `$derived` off it: reading `projectPath`/`trackerModeStorage` keeps it in sync with the prop the normal way, and {@link handleModeChange} reassigning it directly (Svelte 5's writable-derived override) is exactly what lets a just-saved mode take effect immediately, without a separate `$state`/`$effect` pair to keep in sync by hand. */
  const trackerModeStorage = $derived(createLocalStorageTrackerModeStorage(projectPath));
  let trackerMode = $derived<TrackerMode | undefined>(trackerModeStorage.get());

  function handleModeChange(mode: TrackerMode): void {
    trackerMode = mode;
  }

  const accountConnect = $derived<AccountConnectCapability>({
    nodeId,
    client,
    refreshConnectedAccounts: () => client.refreshConnectedAccounts(),
  });

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
  {#if trackerMode !== undefined}
    <TrackerConfigPanel
      presentation="header"
      {projectPath}
      storage={trackerModeStorage}
      {connectedAccounts}
      {accountConnect}
      onChange={handleModeChange}
    />
    <Button variant="secondary" size="sm" onclick={() => (manageTypesDialogOpen = true)}>
      Manage types
    </Button>
    <Button variant="primary" size="sm" onclick={openCreateDialog}>New record</Button>
  {/if}
{/snippet}

<PageLayout title="Tracker" testid="tracker-page" {actions}>
  {#if trackerMode === undefined}
    <div class="tracker-setup" data-testid="tracker-setup">
      <p class="tracker-setup-intro">
        This project has no tracker set up yet. Connect a GitHub or Jira project, or use loombox's
        own local tracker — chosen right here.
      </p>
      <TrackerConfigPanel
        {projectPath}
        storage={trackerModeStorage}
        {connectedAccounts}
        {accountConnect}
        onChange={handleModeChange}
      />
    </div>
  {:else if snapshot.status === 'error' || timedOut}
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
  {:else}
    {#if trackerMode.kind === 'live'}
      <p class="tracker-live-gap-note" data-testid="tracker-live-gap-note">
        <Badge tone="warning" size="sm">Not yet synced</Badge>
        Live tracker sync isn't wired up end to end yet — what's below still comes from the local tracker,
        not {trackerMode.provider === 'github' ? 'GitHub' : 'Jira'} (<a
          href="https://github.com/fiorelorenzo/loombox/issues/631"
          target="_blank"
          rel="noreferrer">#631</a
        >).
      </p>
    {/if}

    {#if snapshot.records.length === 0}
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

  .tracker-setup {
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
    max-width: 34rem;
  }

  .tracker-setup-intro {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .tracker-live-gap-note {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-xs);
    margin: 0 0 var(--space-md);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-surface-raised);
    color: var(--color-text-secondary);
  }

  .tracker-live-gap-note a {
    color: inherit;
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
