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
        <PushNotificationToggle {relayBaseUrl} {authToken} {deviceId} />
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

  /* Same small-uppercase treatment the old Drawer `.settings-tab` gave
     these section headings (`+page.svelte`'s own `.settings-section h3`
     rule): kept identical on purpose, just retargeted from `h3` to `h2`
     now that the page title above claims `h1`. */
  .settings-section h2 {
    margin: 0 0 var(--space-sm);
    font-size: var(--text-small-size);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
</style>
