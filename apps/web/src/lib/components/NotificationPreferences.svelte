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
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §4/§6,
   * issue #434): grouped onto `Card elevation="raised"` sections, quiet
   * hours' checkbox and each mute checkbox become tactile toggle switches
   * (still real `<input type="checkbox">` elements underneath — only their
   * `appearance` is replaced with CSS, so `checked`/`onchange` behavior is
   * untouched), and the muted-project list becomes quiet hairline-divided
   * rows (redesign brief §4 "Rows") instead of a bare `<ul>`. The quiet-
   * hours time range gets a `beat-in` reveal (4px slide + fade,
   * `--duration-base`/`--ease-beat`) when it appears. All `data-testid`s
   * and DOM/element types stay exactly as before this restyle.
   */
  import {
    createLocalStorageNotificationPreferencesStorage,
    setProjectMuted,
    setQuietHours,
    type NotificationPreferences,
    type NotificationPreferencesStorage,
  } from '$lib/notification-preferences';
  import Card from './ui/Card.svelte';

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
  <Card elevation="raised" padding="md">
    <section class="quiet-hours">
      <h3>Quiet hours</h3>
      <label class="quiet-toggle">
        <span class="toggle-switch">
          <input
            type="checkbox"
            checked={quietHoursEnabled}
            onchange={(event) =>
              onQuietHoursEnabledChange((event.currentTarget as HTMLInputElement).checked)}
            data-testid="quiet-hours-enabled"
          />
          <span class="toggle-switch-track" aria-hidden="true"></span>
        </span>
        Mute notifications during quiet hours
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
          <span class="quiet-range-sep">to</span>
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
  </Card>

  {#if projectPaths.length > 0}
    <Card elevation="raised" padding="md">
      <section class="muted-projects">
        <h3>Mute per project</h3>
        <ul>
          {#each projectPaths as projectPath (projectPath)}
            <li>
              <label>
                <span class="toggle-switch">
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
                  <span class="toggle-switch-track" aria-hidden="true"></span>
                </span>
                <span class="project-path">{projectPath}</span>
              </label>
            </li>
          {/each}
        </ul>
      </section>
    </Card>
  {/if}
</div>

<style>
  .notification-preferences {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    font-size: var(--text-small-size);
  }

  .quiet-hours,
  .muted-projects {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  h3 {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text-muted);
    font-weight: 600;
  }

  .quiet-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    cursor: pointer;
    color: var(--color-text-primary);
  }

  .quiet-range {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    padding-left: calc(2rem + var(--space-sm));
    animation: beat-in var(--duration-base) var(--ease-beat);
  }

  .quiet-range-sep {
    color: var(--color-text-muted);
  }

  .quiet-range input[type='time'] {
    font: inherit;
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: inherit;
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .quiet-range input[type='time']:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .muted-projects ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  /* Quiet hairline-divided rows, not boxed cards (redesign brief §4
     "Rows"): a top border on every row after the first, rather than a
     border/background per item. */
  .muted-projects li {
    border-top: 1px solid var(--color-border-subtle);
  }

  .muted-projects li:first-child {
    border-top: none;
  }

  .muted-projects label {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-xs) var(--space-2xs);
    cursor: pointer;
  }

  .project-path {
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }

  /* A tactile toggle switch built on a real, still-fully-functional
     `<input type="checkbox">` — only `appearance` is suppressed, so
     `checked`/`onchange`/`data-testid` behavior is byte-for-byte the same
     as the plain checkbox this replaces visually. */
  .toggle-switch {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    width: 2rem;
    height: 1.15rem;
  }

  .toggle-switch input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
    z-index: 1;
  }

  .toggle-switch-track {
    position: absolute;
    inset: 0;
    border-radius: var(--radius-full);
    background: var(--color-fill);
    border: 1px solid var(--color-border);
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .toggle-switch-track::before {
    content: '';
    position: absolute;
    top: 1px;
    left: 1px;
    width: calc(1.15rem - 4px);
    height: calc(1.15rem - 4px);
    border-radius: var(--radius-full);
    background: var(--color-text-secondary);
    transition:
      transform var(--duration-fast) var(--ease-beat),
      background-color var(--duration-fast) var(--ease-beat);
  }

  .toggle-switch input:checked + .toggle-switch-track {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
  }

  .toggle-switch input:checked + .toggle-switch-track::before {
    background: var(--color-accent);
    transform: translateX(calc(2rem - 1.15rem));
  }

  .toggle-switch input:focus-visible + .toggle-switch-track {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @keyframes beat-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133): a coarse pointer
     gets a larger toggle/time-input hit target than the default. */
  @media (pointer: coarse) {
    .toggle-switch {
      width: 2.75rem;
      height: 1.5rem;
    }

    .toggle-switch-track::before {
      width: calc(1.5rem - 4px);
      height: calc(1.5rem - 4px);
    }

    .toggle-switch input:checked + .toggle-switch-track::before {
      transform: translateX(calc(2.75rem - 1.5rem));
    }

    .quiet-range input[type='time'] {
      min-height: 2.75rem;
      font-size: 1rem;
    }
  }
</style>
