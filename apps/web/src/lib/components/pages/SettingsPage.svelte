<script lang="ts">
  /**
   * Settings as a full page (design spec v4 §3.3, issue #507). Originally the
   * exact three sections the Drawer's `activeDrawer === 'settings'` tab
   * rendered (Appearance, Notifications, Push notifications), now page-shaped
   * instead of a Drawer overlay.
   *
   * Reorganised by issue #568: Nodes & targets moved here from its own
   * sidebar destination (`docs/superpowers/specs/2026-07-25-ia-v4-design.md`
   * §3.1's "Primary destinations: Inbox, Nodes, Settings" is amended — see
   * that doc's own amendment note). Four sections split into two different
   * kinds — Appearance/Notifications/Push are per-device preferences, Nodes
   * is infrastructure with its own actions and live polling — so a flat
   * `<h2>` stack stopped working: this now has real section navigation, a
   * left sub-nav at `--bp-tablet` and above, a horizontally-scrolling
   * segmented control below it (both drive the exact same `section` state,
   * toggled by CSS alone, mirroring how `+page.svelte`'s own sidebar/tabbar
   * pair already split desktop vs. narrow navigation).
   *
   * `section` is a plain prop, not `$bindable`: `InboxPage`/`NodesPage`
   * (gone as of this issue) both stuck to one-way props + callbacks, and
   * `+page.svelte` needs to both drive this itself (the ⋯ "Target status"
   * deep link jumps straight to `'nodes'`, `openTargetStatus`'s doc comment)
   * and react to it (dropping a stale `focusTarget` — `selectSettingsSection`
   * there), so it stays the single source of truth rather than mirroring it
   * into local component state.
   */
  import type {
    NotificationPreferences as NotificationPreferencesData,
    NotificationPreferencesStorage,
  } from '$lib/notification-preferences';
  import type { ConnectedAccount, TargetListEntry } from '$lib/relay-client';
  import AppearanceSettings from '../AppearanceSettings.svelte';
  import ConnectedAccountsSection, {
    type ConnectedAccountsClient,
  } from '../ConnectedAccountsSection.svelte';
  import NotificationPreferences from '../NotificationPreferences.svelte';
  import PushNotificationToggle from '../PushNotificationToggle.svelte';
  import TargetStatusView, { type FocusTarget } from '../TargetStatusView.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import PageLayout from './PageLayout.svelte';

  export type SettingsSection = 'appearance' | 'notifications' | 'push' | 'nodes' | 'accounts';

  interface Props {
    /** `undefined` until `+page.svelte`'s `onMount` constructs the real, localStorage-backed store (SSR has no `localStorage`); mirrors that mount site's own `{#if notificationPreferencesStorage}` guard. */
    notificationPreferencesStorage: NotificationPreferencesStorage | undefined;
    projectPaths: string[];
    onNotificationPreferencesChange: (preferences: NotificationPreferencesData) => void;
    /** `undefined` before this device's id has loaded; mirrors the old mount site's own `{#if deviceId}` guard around `PushNotificationToggle`. */
    deviceId: string | undefined;
    relayBaseUrl: string;
    authToken: string;
    /** The former `NodesPage` props (issue #568's merge): `+page.svelte` still owns polling `listTargets()` and passes the latest snapshot straight through, unchanged from when this was its own destination. */
    targets: TargetListEntry[];
    loading: boolean;
    error: string | undefined;
    focusTarget?: FocusTarget;
    onRefresh: () => void;
    /** Opens the zero-touch provision-and-pair wizard (`AddTargetWizard`); moved onto this section from the old `NodesPage`'s own page actions. */
    onAddTarget: () => void;
    onConnectNode: () => void;
    /** SPEC §7.26's connected-accounts write path (issue #230) — `undefined` before `+page.svelte`'s `RelayClient` is constructed, mirroring `deviceId`'s own "gate the whole section on prerequisite readiness" pattern. */
    client?: ConnectedAccountsClient;
    /** `RelayClient.connectedAccounts`'s latest snapshot — always an array (empty before the first sync), never gates the section on its own. */
    connectedAccounts?: ConnectedAccount[];
    /** Which section is showing; defaults to `'appearance'` so a caller that never sets it (every current test but the ones that care) still renders a complete page. */
    section?: SettingsSection;
    /** Fired when the sub-nav/segmented control picks a different section — `+page.svelte` owns `section` itself, this is how a click here reaches that state (see this component's own doc comment for why it isn't `$bindable`). */
    onSectionChange?: (section: SettingsSection) => void;
  }

  const {
    notificationPreferencesStorage,
    projectPaths,
    onNotificationPreferencesChange,
    deviceId,
    relayBaseUrl,
    authToken,
    targets,
    loading,
    error,
    focusTarget,
    onRefresh,
    onAddTarget,
    onConnectNode,
    client,
    connectedAccounts = [],
    section = 'appearance',
    onSectionChange,
  }: Props = $props();

  interface SectionItem {
    id: SettingsSection;
    label: string;
  }

  /** Notifications/Push/Accounts only ever show up once their own prerequisite is ready (mirrors the old Drawer tab guards verbatim), so the nav never offers a section with nothing behind it. Nodes has no such gate: it's always there, same as Appearance. */
  const visibleSections = $derived(
    (
      [
        { id: 'appearance', label: 'Appearance' },
        notificationPreferencesStorage
          ? { id: 'notifications', label: 'Notifications' }
          : undefined,
        deviceId ? { id: 'push', label: 'Push' } : undefined,
        { id: 'nodes', label: 'Nodes' },
        client ? { id: 'accounts', label: 'Accounts' } : undefined,
      ] satisfies Array<SectionItem | undefined>
    ).filter((item): item is SectionItem => item !== undefined),
  );

  /** Falls back to `'appearance'` if the current `section` names one that isn't visible right now (e.g. `deviceId` disappears mid-session) — the page must always show something rather than going blank. */
  const activeSection = $derived(
    visibleSections.some((item) => item.id === section) ? section : 'appearance',
  );

  function selectSection(id: SettingsSection): void {
    onSectionChange?.(id);
  }
</script>

{#snippet nodesActions()}
  <Button
    variant="secondary"
    size="sm"
    onclick={onConnectNode}
    dataTestId="nodes-page-connect-node"
  >
    Connect a node
  </Button>
  <Button variant="primary" size="sm" onclick={onAddTarget} dataTestId="nodes-page-add-target">
    Add target
  </Button>
{/snippet}

<PageLayout title="Settings" testid="settings-page">
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="Settings sections" data-testid="settings-nav">
      {#each visibleSections as item (item.id)}
        <button
          type="button"
          class="settings-nav-item"
          class:active={item.id === activeSection}
          aria-current={item.id === activeSection ? 'page' : undefined}
          onclick={() => selectSection(item.id)}
          data-testid={`settings-nav-${item.id}`}
        >
          {item.label}
        </button>
      {/each}
    </nav>

    <div
      class="settings-tabs"
      role="tablist"
      aria-label="Settings sections"
      data-testid="settings-tabs"
    >
      {#each visibleSections as item (item.id)}
        <button
          type="button"
          role="tab"
          class="settings-tab"
          class:active={item.id === activeSection}
          aria-selected={item.id === activeSection}
          onclick={() => selectSection(item.id)}
          data-testid={`settings-tab-${item.id}`}
        >
          {item.label}
        </button>
      {/each}
    </div>

    <div class="settings-panel">
      {#if activeSection === 'appearance'}
        <section class="settings-section">
          <h2>Appearance</h2>
          <AppearanceSettings />
        </section>
      {:else if activeSection === 'notifications' && notificationPreferencesStorage}
        <section class="settings-section">
          <h2>Notifications</h2>
          <NotificationPreferences
            {projectPaths}
            storage={notificationPreferencesStorage}
            onChange={onNotificationPreferencesChange}
          />
        </section>
      {:else if activeSection === 'push' && deviceId}
        <section class="settings-section">
          <h2>Push notifications</h2>
          <Card elevation="raised" padding="md">
            <PushNotificationToggle {relayBaseUrl} {authToken} {deviceId} />
          </Card>
        </section>
      {:else if activeSection === 'nodes'}
        <section class="settings-section" data-testid="settings-section-nodes">
          <div class="settings-section-header">
            <h2>Nodes and targets</h2>
            <div class="settings-section-actions">
              {@render nodesActions()}
            </div>
          </div>
          <TargetStatusView {targets} {loading} {error} {focusTarget} {onRefresh} />
        </section>
      {:else if activeSection === 'accounts' && client}
        <section class="settings-section" data-testid="settings-section-accounts">
          <h2>Connected accounts</h2>
          <ConnectedAccountsSection {client} {connectedAccounts} {targets} {projectPaths} />
        </section>
      {/if}
    </div>
  </div>
</PageLayout>

<style>
  .settings-layout {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2xl);
  }

  /* The desktop left sub-nav (design spec §3, issue #568's "left sub-nav on
     desktop"). Hidden below `--bp-tablet` in favour of `.settings-tabs`
     below — both are always in the DOM and toggled by the same `@media`
     query pair the shell's own sidebar/tabbar split already uses
     (`+page.svelte`'s `.tabbar`/`@media (max-width: 1023px)`), rather than a
     JS viewport read, so this stays purely presentational. */
  .settings-nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
    flex-shrink: 0;
    width: 12rem;
  }

  .settings-nav-item {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-secondary);
    padding: var(--space-xs) var(--space-sm);
    font-size: var(--text-body-size);
    cursor: pointer;
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .settings-nav-item:hover,
  .settings-nav-item:focus-visible {
    background: var(--color-fill-subtle);
  }

  .settings-nav-item.active {
    background: var(--color-fill);
    color: var(--color-text-primary);
    font-weight: 600;
  }

  /* The narrow-viewport segmented control (design spec §3, issue #568's "a
     segmented control ... on narrow"). `overflow-x: auto` rather than
     wrapping: four short labels already fit most phone widths in one row,
     and a control that reflows to two rows reads as two different groups. */
  .settings-tabs {
    display: none;
    gap: var(--space-2xs);
    overflow-x: auto;
    padding-bottom: var(--space-2xs);
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .settings-tab {
    flex-shrink: 0;
    border: none;
    border-radius: var(--radius-full);
    background: var(--color-fill-subtle);
    color: var(--color-text-secondary);
    padding: var(--space-2xs) var(--space-sm);
    font-size: var(--text-small-size);
    cursor: pointer;
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .settings-tab.active {
    background: var(--color-accent-subtle);
    color: var(--color-accent);
    font-weight: 600;
  }

  .settings-panel {
    flex: 1;
    min-width: 0;
  }

  .settings-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-md);
    margin-bottom: var(--space-sm);
  }

  .settings-section-header h2 {
    margin: 0;
  }

  .settings-section-actions {
    display: flex;
    gap: var(--space-sm);
    flex-shrink: 0;
  }

  /* A real section heading now, not the tiny uppercase-tracked caption
     look every card's own `h3` (and `ui/Field`'s label) already uses
     for a field group — reusing that look here is what made a page
     section and a card's internal field group read as the same
     hierarchy level, tellable apart only by which one sat higher on the
     page (design spec §0.8). `--text-body-size`, sentence case, mirrors
     the pre-auth sign-in screen's own minimal `.appearance-settings-panel
     h2` in `+page.svelte` — the one other place this app already draws
     a heading one step down from a page's `h1`. */
  .settings-section h2 {
    margin: 0 0 var(--space-sm);
    font-size: var(--text-body-size);
  }

  /* Below `--bp-tablet` (768px): the left sub-nav gives way to the
     segmented control above the panel, same cutover point the Drawer's own
     bottom-sheet breakpoint uses (`+page.svelte`'s `@media (max-width:
     767px)`). */
  @media (max-width: 767px) {
    .settings-layout {
      flex-direction: column;
      gap: var(--space-lg);
    }

    .settings-nav {
      display: none;
    }

    .settings-tabs {
      display: flex;
    }
  }
</style>
