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
   * picker into this page, reading `tracker-mode-store.ts` (#209, made
   * node-backed by #631) so this page can branch on it — `Config`'s old
   * Tracker section is deleted outright, not mirrored (F2-1 was not
   * picked), so this is now the ONLY place a project's tracker mode is
   * shown or changed. No mode saved yet: the page's own empty state stops
   * being blank and becomes `TrackerConfigPanel`'s own setup form,
   * rendered inline (F1-1) — the exact surface issue #220 already built,
   * just relocated. A mode already saved: the header's `actions` cluster
   * gets a compact "what is this / change what this is" control instead
   * (F2-2), the same `TrackerConfigPanel` in its `presentation="header"`
   * shape (a `Dialog`, not an inline form — a page-header bar has no room
   * to grow one). `accountConnect` threads this page's own already-known
   * `nodeId` (the project's own node, so unlike Settings' accounts
   * section there is no node to pick) into that panel's "Connect
   * GitHub"/"Connect Jira" empty-state CTA.
   *
   * **#631 closed the bridge-dispatch gap too, not just transport.**
   * `NodeDaemon.readTrackerSnapshotForBridge`/`applyTrackerWriteForBridge`
   * (`packages/node/src/node-daemon.ts`) used to read the local native
   * store unconditionally, so a project switched to `live` still showed
   * local records, with no error — the mode reached the node (this
   * file's own earlier gap) but nothing on the node consulted it. Both
   * bridge paths now dispatch on the mode through one shared resolver
   * (`resolveTrackerDispatch`, node-side); a `live` mode that cannot
   * resolve (missing account, revoked credential, unpinned write, ...)
   * comes back as `snapshot.status === 'error'` below, never a silent
   * fallback to the local store — SPEC §7.10's explicit
   * connectivity-error state. `snapshot.errorReason` (SPEC §7.10, issue
   * #631) carries the structured `TrackerBackendResolutionError` kind
   * when the failure is a resolution failure specifically; `RESOLUTION_ERROR_COPY`
   * below is what renders it as more than a bare message.
   *
   * **Issue #697: this page no longer needs a session at all.** Every
   * wire request it sends — tracker mode (already node-addressed since
   * #631) AND, as of this fix, tracker snapshot/write — is addressed by
   * `nodeId` + `projectPath` alone, sealed to a project key
   * (`@loombox/crypto`'s `deriveProjectKey`), not a session key. Before
   * #697 the records half rode `sessionId`, which made them unreachable
   * whenever no agent session happened to be running for the project —
   * this component takes `nodeId`/`projectPath` props directly now and
   * has no `sessionId` prop left to take.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import type { Readable } from 'svelte/store';
  import type {
    ConnectedAccount,
    TrackerBackendResolutionErrorV1,
    TrackerMode,
  } from '@loombox/protocol';
  import {
    buildTrackerTypeRegistryV1,
    type TrackerRecordV1,
    type TrackerRoleV1,
    type TrackerTypeDefinitionV1,
  } from '@loombox/protocol';
  import type { TrackerSnapshotState } from '$lib/relay-client';
  import {
    createRelayTrackerModeStorage,
    type RelayTrackerModeStorage,
    type TrackerModeClient,
  } from '$lib/tracker-mode-store';
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

  /** Mirrors `RelayClient`'s own tracker methods field-for-field (every write takes `nodeId`+`projectPath` as its first two arguments, matching `RelayClient.createTrackerRecord`/`updateTrackerRecord`/`defineTrackerType`'s real signatures — issue #697 re-addressed these off `sessionId` entirely) — {@link dialogClient} below adapts this into the node/project-free shape `TrackerRecordDialog`/`TrackerManageTypesDialog` expect. Also extends `GithubConnectClient`/`JiraConnectClient`/`TrackerModeClient` (the last for issue #631's node-backed mode — `createRelayTrackerModeStorage`'s own narrow-client seam) and carries `refreshConnectedAccounts` (issue #672): `RelayClient` already implements all four (issue #230/#221/#631), and this page's own `accountConnect` prop to `TrackerConfigPanel` needs the connect ones — see the file doc comment. */
  export interface TrackerPageClient
    extends GithubConnectClient, JiraConnectClient, TrackerModeClient {
    trackerSnapshotFor: (nodeId: string, projectPath: string) => Readable<TrackerSnapshotState>;
    reloadTrackerSnapshot: (nodeId: string, projectPath: string) => void;
    createTrackerRecord: (
      nodeId: string,
      projectPath: string,
      input: { primaryType: string; typeTags?: string[]; fields: Record<string, unknown> },
    ) => Promise<TrackerRecordV1>;
    updateTrackerRecord: (
      nodeId: string,
      projectPath: string,
      id: string,
      patch: {
        primaryType?: string;
        typeTags?: string[];
        fields?: Record<string, unknown>;
        archived?: boolean;
      },
    ) => Promise<TrackerRecordV1>;
    defineTrackerType: (
      nodeId: string,
      projectPath: string,
      type: { id: string; label: string; roles: Partial<Record<TrackerRoleV1, string>> },
    ) => Promise<TrackerTypeDefinitionV1>;
    refreshConnectedAccounts: () => void;
  }

  interface Props {
    client: TrackerPageClient;
    /** Keys `tracker-mode-store.ts`'s storage, same as `ProjectConfigPanel`'s old `projectPath` prop did. */
    projectPath: string;
    /**
     * The project's own node (SPEC §7.26's node-locality) — every wire
     * request this page sends (tracker mode AND, since issue #697,
     * tracker records) is addressed by this plus {@link projectPath}
     * alone, with no session involved. `undefined` degrades to a real
     * error state below (mirrors `GithubConnectFlow`/`JiraConnectForm`'s
     * own "select a node" message) rather than hiding the page or
     * guessing.
     */
    nodeId: string | undefined;
    /** `RelayClient.connectedAccounts`'s latest snapshot — forwarded straight to `TrackerConfigPanel`, same "this page fetches nothing of its own" split every prop here already follows. */
    connectedAccounts?: readonly ConnectedAccount[];
  }

  const { client, projectPath, nodeId, connectedAccounts = [] }: Props = $props();

  /**
   * This project's saved tracker mode (issue #672, node-backed by #631).
   * `trackerModeStatus` is the real three-way state this page MUST gate
   * rendering on (see `tracker-mode-store.ts`'s own doc comment):
   * `'loading'` renders neither the setup step nor the board below — a
   * saved `live` mode must never flash the "choose a mode" setup step
   * while the node round trip is still in flight, which reading
   * `trackerMode === undefined` alone (this field's old, sync-
   * `localStorage`-only meaning) would do here. `trackerMode`/
   * `trackerModeError` are `$state`, not `$derived`, because they're fed
   * by `RelayTrackerModeStorage`'s own async `subscribe` — {@link
   * subscribeTrackerMode} rebuilds the storage and re-subscribes whenever
   * `projectPath`/`nodeId` changes, mirroring {@link subscribe}'s
   * identical re-subscribe contract for the tracker snapshot further
   * below. {@link handleModeChange} still reassigns `trackerMode` directly
   * the moment a save succeeds, so it takes effect immediately rather than
   * waiting on the store's own round trip to catch up (the store settles
   * to the same value moments later, a harmless no-op reassignment).
   */
  let trackerModeStorage = $state<RelayTrackerModeStorage | undefined>(undefined);
  let trackerModeStatus = $state<'loading' | 'loaded' | 'error'>('loading');
  let trackerMode = $state<TrackerMode | undefined>(undefined);
  let trackerModeError = $state<string | undefined>(undefined);
  let unsubscribeTrackerMode: (() => void) | undefined;

  function subscribeTrackerMode(): void {
    unsubscribeTrackerMode?.();
    if (nodeId === undefined) {
      // No node bound to this project (yet) — a real, named error state
      // (SPEC §7.10 forbids guessing a mode with no node to ask), never a
      // silent "never chosen" that would offer a setup form pointed at
      // nowhere.
      trackerModeStorage = undefined;
      trackerModeStatus = 'error';
      trackerModeError = 'No node is available for this project yet.';
      trackerMode = undefined;
      return;
    }
    const storage = createRelayTrackerModeStorage(client, nodeId, projectPath);
    trackerModeStorage = storage;
    unsubscribeTrackerMode = storage.subscribe((state) => {
      trackerModeStatus = state.status;
      trackerMode = state.mode;
      trackerModeError = state.error;
    });
  }

  onDestroy(() => unsubscribeTrackerMode?.());

  // Re-subscribes if the caller ever points this page at a different
  // project/node (mirrors `subscribe`'s own identical re-subscribe effect
  // for the tracker snapshot below).
  $effect(() => {
    void projectPath;
    void nodeId;
    subscribeTrackerMode();
  });

  function handleModeChange(mode: TrackerMode): void {
    trackerMode = mode;
  }

  function retryTrackerMode(): void {
    trackerModeStorage?.reload();
  }

  const accountConnect = $derived<AccountConnectCapability>({
    nodeId,
    client,
    refreshConnectedAccounts: () => client.refreshConnectedAccounts(),
  });

  /** A short label per `TrackerBackendResolutionErrorV1.kind` (SPEC §7.10, issue #631) — the badge above `ErrorNotice`'s own message when `snapshot.errorReason` is set, mirroring `AccountPinPicker.svelte`'s identical "a `Badge` per resolution-error kind" convention for #227's five pin errors. `nativeMode` is included for exhaustiveness (the bridge dispatch never actually produces it for a live-mode snapshot) rather than leaving this map's keys out of sync with the wire union. */
  const RESOLUTION_ERROR_BADGE: Record<TrackerBackendResolutionErrorV1['kind'], string> = {
    nativeMode: 'Native mode',
    accountNotConnected: 'Not connected',
    accountPinRequired: 'Pin required',
    accountPinMalformed: 'Malformed pin',
    accountPinDangling: 'Dangling pin',
    accountHostMismatch: 'Host mismatch',
    accountAmbiguous: 'Ambiguous',
    accountPinOptedOut: 'Opted out',
    connectionPinMismatch: 'Mode/pin mismatch',
    credentialUnavailable: 'Credential unavailable',
    credentialSourceUnsupported: 'Unsupported credential',
  };

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
    if (nodeId === undefined) {
      // Mirrors `subscribeTrackerMode`'s own guard just above: with no
      // node to ask, there is nothing to fetch — the tracker-mode error
      // state already covers this in the template (it renders first), so
      // this store is simply never consulted while that holds.
      return;
    }
    unsubscribe = client.trackerSnapshotFor(nodeId, projectPath).subscribe((value) => {
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
  // project/node (a mount-time-only `onMount` would keep listening to the
  // OLD project's store forever otherwise; issue #697 dropped `sessionId`
  // as the reactive key in favor of the two fields that actually address
  // the tracker now).
  $effect(() => {
    void nodeId;
    void projectPath;
    subscribe();
    timedOut = false;
  });

  function retry(): void {
    timedOut = false;
    if (nodeId === undefined) return;
    client.reloadTrackerSnapshot(nodeId, projectPath);
  }

  const registry = $derived(buildTrackerTypeRegistryV1(snapshot.types));

  /**
   * `nodeId` is only ever `undefined` while the tracker-mode error state
   * above is showing (see {@link subscribeTrackerMode}'s guard) — none of
   * `dialogClient`'s methods below are reachable from the template until
   * `trackerModeStatus === 'loaded'`, which cannot happen without a node.
   * Throws rather than silently no-op-ing if that invariant is ever
   * wrong, matching this codebase's "never a silent drop" convention.
   */
  function requireNodeId(): string {
    if (nodeId === undefined) {
      throw new Error('TrackerPage: no node available for this project');
    }
    return nodeId;
  }

  /** Adapts {@link client} into the node/project-free shape `TrackerRecordDialog`/`TrackerManageTypesDialog` expect (both mirror `AddProjectDialog`'s established "a dialog calls its own narrow client directly" convention) — binds `nodeId`/`projectPath` once here (issue #697) rather than threading them through every dialog prop. */
  const dialogClient = $derived<TrackerRecordClient & TrackerTypeClient>({
    createTrackerRecord: (input) => client.createTrackerRecord(requireNodeId(), projectPath, input),
    updateTrackerRecord: (id, patch) =>
      client.updateTrackerRecord(requireNodeId(), projectPath, id, patch),
    defineTrackerType: (type) => client.defineTrackerType(requireNodeId(), projectPath, type),
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
    if (!key || nodeId === undefined) return;
    void client.updateTrackerRecord(nodeId, projectPath, id, {
      fields: { ...record.fields, [key]: workflowStatus },
    });
  }
</script>

{#snippet actions()}
  {#if trackerModeStatus === 'loaded' && trackerMode !== undefined}
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
  {#if trackerModeStatus === 'loading'}
    <p class="tracker-page-loading" data-testid="tracker-mode-loading">
      <WovenLoader size="sm" label="Loading tracker mode" />
      Loading…
    </p>
  {:else if trackerModeStatus === 'error'}
    <ErrorNotice
      message={trackerModeError ?? "Could not reach this project's node to load its tracker mode."}
      retryable
      onRetry={retryTrackerMode}
    />
  {:else if trackerMode === undefined}
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
    <div class="tracker-snapshot-error" data-testid="tracker-snapshot-error">
      {#if !timedOut && snapshot.errorReason}
        <Badge tone="danger" size="sm" dataTestId="tracker-snapshot-error-badge">
          {RESOLUTION_ERROR_BADGE[snapshot.errorReason.kind]}
        </Badge>
      {/if}
      <ErrorNotice
        message={timedOut
          ? "This project's tracker didn't answer in time. The node isn't reachable right now, or this relay predates project-scoped tracker requests (issue #697)."
          : (snapshot.error ?? 'Failed to load the tracker.')}
        retryable
        onRetry={retry}
      />
    </div>
  {:else if snapshot.status === 'loading'}
    <p class="tracker-page-loading" data-testid="tracker-page-loading">
      <WovenLoader size="sm" label="Loading tracker" />
      Loading…
    </p>
  {:else}
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

  .tracker-snapshot-error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-xs);
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
