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
  import Checkbox from './ui/Checkbox.svelte';
  import Input from './ui/Input.svelte';

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
      <Checkbox
        checked={quietHoursEnabled}
        label="Mute notifications during quiet hours"
        onCheckedChange={onQuietHoursEnabledChange}
        dataTestId="quiet-hours-enabled"
      />
      {#if quietHoursEnabled}
        <div class="quiet-range">
          <Input
            type="time"
            value={quietStart}
            onchange={onQuietStartChange}
            ariaLabel="Quiet hours start"
            dataTestId="quiet-hours-start"
          />
          <span class="quiet-range-sep">to</span>
          <Input
            type="time"
            value={quietEnd}
            onchange={onQuietEndChange}
            ariaLabel="Quiet hours end"
            dataTestId="quiet-hours-end"
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
              <!-- `label={projectPath}` uses Checkbox's own label typography
                   directly rather than a separate `.project-path`-styled
                   sibling; the path is the only content in this row anyway. -->
              <Checkbox
                checked={preferences.mutedProjects.includes(projectPath)}
                label={projectPath}
                onCheckedChange={(checked) => toggleProjectMuted(projectPath, checked)}
                dataTestId={`mute-project-${projectPath}`}
              />
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
    font-size: var(--text-caption-size);
    letter-spacing: var(--text-caption-tracking);
    text-transform: uppercase;
    color: var(--color-text-muted);
    font-weight: 600;
  }

  /* Indents the time-range row to align under the label text above it,
     not under the toggle switch itself: `--space-2xl` (2rem) is
     `ui/Checkbox`'s own `.ui-checkbox-track` width, `--space-sm` its gap
     to the label (issue #508 token-hygiene finding — this was a bare
     `2rem` literal that happened to equal the token, not a genuine gap in
     the spacing scale). */
  .quiet-range {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    padding-left: calc(var(--space-2xl) + var(--space-sm));
    animation: beat-in var(--duration-base) var(--ease-beat);
  }

  .quiet-range-sep {
    color: var(--color-text-muted);
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
</style>
