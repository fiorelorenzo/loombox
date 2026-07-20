<script lang="ts">
  /**
   * The per-project mute + quiet-hours settings panel (SPEC.md §7.11
   * "Per-project mute and quiet-hours let the user tune what interrupts
   * them", issue #166). A plain settings form over `$lib/notification-
   * preferences.ts`'s pure storage/logic — this component owns no
   * suppression logic itself, only reads/writes preferences and reports
   * every change via `onChange` so the caller (`+page.svelte`) can push the
   * result to the service worker (`syncNotificationPreferencesToServiceWorker`,
   * #166's SW-side enforcement).
   *
   * "Project" is `ClientSessionMeta.projectPath` — v1 has no separate
   * project entity, so the caller derives `projectPaths` from its live
   * session list.
   */
  import {
    createLocalStorageNotificationPreferencesStorage,
    setProjectMuted,
    setQuietHours,
    type NotificationPreferences,
    type NotificationPreferencesStorage,
  } from '$lib/notification-preferences';

  interface Props {
    /** Distinct project paths available to mute, from the caller's live session list. */
    projectPaths: string[];
    /** Injectable for tests; defaults to the real localStorage-backed store. */
    storage?: NotificationPreferencesStorage;
    /** Called with the new preferences after every change. */
    onChange?: (preferences: NotificationPreferences) => void;
  }

  const {
    projectPaths,
    storage = createLocalStorageNotificationPreferencesStorage(),
    onChange,
  }: Props = $props();

  // Read once at mount into a plain local, then split across independent
  // `$state` fields the handlers below update locally — reading `preferences`
  // (itself `$state`) back out of its own initializer to seed the others
  // would only capture its initial value anyway (Svelte 5 warns on exactly
  // this), so each field is seeded from this one plain snapshot instead. Same
  // one-shot-initial-read intent as `PushNotificationToggle.svelte`'s `support`.
  function readInitialPreferences(): NotificationPreferences {
    return storage.get();
  }

  const initialPreferences = readInitialPreferences();
  let preferences = $state<NotificationPreferences>(initialPreferences);
  let quietHoursEnabled = $state(initialPreferences.quietHours !== undefined);
  let quietStart = $state(initialPreferences.quietHours?.start ?? '22:00');
  let quietEnd = $state(initialPreferences.quietHours?.end ?? '07:00');

  function toggleProjectMuted(projectPath: string, muted: boolean): void {
    preferences = setProjectMuted(storage, projectPath, muted);
    onChange?.(preferences);
  }

  function applyQuietHours(): void {
    preferences = setQuietHours(
      storage,
      quietHoursEnabled ? { start: quietStart, end: quietEnd } : undefined,
    );
    onChange?.(preferences);
  }

  function onQuietHoursEnabledChange(enabled: boolean): void {
    quietHoursEnabled = enabled;
    applyQuietHours();
  }

  // Explicit value + onchange (not `bind:value`) so the new value is read
  // and persisted atomically in one handler, with no dependency on Svelte's
  // own binding listener firing before ours on the same `change` event.
  function onQuietStartChange(event: Event): void {
    quietStart = (event.currentTarget as HTMLInputElement).value;
    applyQuietHours();
  }

  function onQuietEndChange(event: Event): void {
    quietEnd = (event.currentTarget as HTMLInputElement).value;
    applyQuietHours();
  }
</script>

<div class="notification-preferences" data-testid="notification-preferences">
  <section class="quiet-hours">
    <label class="quiet-toggle">
      <input
        type="checkbox"
        checked={quietHoursEnabled}
        onchange={(event) =>
          onQuietHoursEnabledChange((event.currentTarget as HTMLInputElement).checked)}
        data-testid="quiet-hours-enabled"
      />
      Quiet hours
    </label>
    {#if quietHoursEnabled}
      <div class="quiet-range">
        <input
          type="time"
          value={quietStart}
          onchange={onQuietStartChange}
          aria-label="Quiet hours start"
          data-testid="quiet-hours-start"
        />
        <span>to</span>
        <input
          type="time"
          value={quietEnd}
          onchange={onQuietEndChange}
          aria-label="Quiet hours end"
          data-testid="quiet-hours-end"
        />
      </div>
    {/if}
  </section>

  {#if projectPaths.length > 0}
    <section class="muted-projects">
      <h3>Mute per project</h3>
      <ul>
        {#each projectPaths as projectPath (projectPath)}
          <li>
            <label>
              <input
                type="checkbox"
                checked={preferences.mutedProjects.includes(projectPath)}
                onchange={(event) =>
                  toggleProjectMuted(
                    projectPath,
                    (event.currentTarget as HTMLInputElement).checked,
                  )}
                data-testid={`mute-project-${projectPath}`}
              />
              {projectPath}
            </label>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .notification-preferences {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    font-size: 0.85rem;
  }

  .quiet-hours,
  .muted-projects {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  h3 {
    margin: 0;
    font-size: 0.8rem;
    opacity: 0.7;
    font-weight: 600;
  }

  .quiet-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
  }

  .quiet-range {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .muted-projects ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .muted-projects label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133): a coarse pointer
     gets a larger checkbox hit target than the default ~13px browser box. */
  @media (pointer: coarse) {
    input[type='checkbox'] {
      width: 1.25rem;
      height: 1.25rem;
    }

    input[type='time'] {
      min-height: 2.75rem;
      font-size: 1rem;
    }
  }
</style>
