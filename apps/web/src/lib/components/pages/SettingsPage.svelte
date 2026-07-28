<script lang="ts">
  /**
   * Settings as a full page (design spec v4 §3.3, issue #507): the exact
   * three sections the Drawer's `activeDrawer === 'settings'` tab rendered
   * (Appearance, Notifications, Push notifications: `+page.svelte`'s own
   * `settings-tab` markup before this issue), now page-shaped instead of a
   * Drawer overlay. None of the three sub-panels change, same as
   * `InboxPage`/`NodesPage`: only the container around them does.
   *
   * Unlike those two, this isn't a 1:1 component swap (the old tab already
   * composed three separate panels, not one), so its props aren't one
   * panel's prop list but the union of what all three needed, named after
   * the exact same variables `+page.svelte` already holds in scope
   * (`notificationPreferencesStorage`, `projectPaths`,
   * `onNotificationPreferencesChange`, `deviceId`) plus the two values
   * `PushNotificationToggle` needs that `+page.svelte` used to compute
   * inline at the mount site (`relayHttpBaseUrl(relayUrl)`,
   * `authSession.token`), passed here already-evaluated, since that
   * computation stays the shell's, not this page's.
   */
  import type {
    NotificationPreferences as NotificationPreferencesData,
    NotificationPreferencesStorage,
  } from '$lib/notification-preferences';
  import AppearanceSettings from '../AppearanceSettings.svelte';
  import NotificationPreferences from '../NotificationPreferences.svelte';
  import PushNotificationToggle from '../PushNotificationToggle.svelte';
  import Card from '../ui/Card.svelte';
  import PageLayout from './PageLayout.svelte';

  interface Props {
    /** `undefined` until `+page.svelte`'s `onMount` constructs the real, localStorage-backed store (SSR has no `localStorage`); mirrors that mount site's own `{#if notificationPreferencesStorage}` guard. */
    notificationPreferencesStorage: NotificationPreferencesStorage | undefined;
    projectPaths: string[];
    onNotificationPreferencesChange: (preferences: NotificationPreferencesData) => void;
    /** `undefined` before this device's id has loaded; mirrors the old mount site's own `{#if deviceId}` guard around `PushNotificationToggle`. */
    deviceId: string | undefined;
    relayBaseUrl: string;
    authToken: string;
  }

  const {
    notificationPreferencesStorage,
    projectPaths,
    onNotificationPreferencesChange,
    deviceId,
    relayBaseUrl,
    authToken,
  }: Props = $props();
</script>

<PageLayout title="Settings" testid="settings-page">
  <div class="settings-sections">
    <section class="settings-section">
      <h2>Appearance</h2>
      <AppearanceSettings />
    </section>
    {#if notificationPreferencesStorage}
      <section class="settings-section">
        <h2>Notifications</h2>
        <NotificationPreferences
          {projectPaths}
          storage={notificationPreferencesStorage}
          onChange={onNotificationPreferencesChange}
        />
      </section>
    {/if}
    {#if deviceId}
      <section class="settings-section">
        <h2>Push notifications</h2>
        <Card elevation="raised" padding="md">
          <PushNotificationToggle {relayBaseUrl} {authToken} {deviceId} />
        </Card>
      </section>
    {/if}
  </div>
</PageLayout>

<style>
  .settings-sections {
    display: flex;
    flex-direction: column;
    gap: var(--space-xl);
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
</style>
