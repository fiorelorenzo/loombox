<script lang="ts">
  /**
   * A project's tracker mode config surface (SPEC §7.10; issue #220): the
   * one-time-per-project choice between loombox's own `native` tracker and
   * a `live` tracker against a connected GitHub/Jira account+target, plus
   * whatever it takes to change that choice later. Reads/writes
   * `tracker-mode-store.ts` (#209) — this component never persists
   * anything itself beyond calling `storage.set`, and never reaches for a
   * default: `storage.get()` returning `undefined` is a real, distinct
   * state (never chosen yet), not coerced into `native`, exactly matching
   * that module's own "no default silently assumed" contract.
   *
   * Draft validation goes through `tracker-config-form.ts`'s
   * `buildTrackerMode`, which itself is a thin wrapper over
   * `@loombox/protocol`'s own `trackerMode` schema — this component's job
   * is only collecting the raw field strings and showing whatever error
   * that validation returns, never re-deriving the rules.
   *
   * **No mode set yet**: opens straight into the picker (no "current mode"
   * card to show), satisfying issue #220's "prompts the user to choose
   * native or live before any tracker UI renders" — there is no other
   * tracker UI behind this panel to gate in this client yet, so the gate is
   * this panel itself always rendering its own picker first.
   *
   * **Switching an existing mode is explicit, not silent** (issue #220's
   * own acceptance line): once a mode is saved, this shows a read-only
   * summary (`describeTrackerMode`) with a "Change tracker mode" button —
   * the editable form only reappears after that deliberate click, pre-
   * filled from the current mode (`liveTrackerDraftFrom`) rather than
   * blank. Switching never touches any tracker data of its own (this
   * component only ever writes the `TrackerMode` value; native/live have
   * no shared record to migrate between, per SPEC §7.10's "no local mirror,
   * no import step" scope cut) — there is nothing here to migrate.
   *
   * The mode/provider pickers are genuinely mutually-exclusive choices, so
   * both use the shared `RadioGroup` (real `role="radiogroup"`), the same
   * precedent issue #549 set for `ConfigBar`'s own mode control over an
   * `aria-pressed` toolbar.
   *
   * `connectedAccounts` is the caller's `RelayClient.connectedAccounts`
   * snapshot, passed straight through — this panel does no fetching of its
   * own, mirroring `ProjectConfigPanel`'s existing sibling panels.
   */
  import type { ConnectedAccount, TrackerMode } from '@loombox/protocol';
  import {
    buildTrackerMode,
    describeTrackerMode,
    emptyLiveTrackerDraft,
    liveTrackerDraftFrom,
    type LiveTrackerDraft,
    type LiveProvider,
    type TrackerModeKind,
  } from '$lib/tracker-config-form';
  import {
    createLocalStorageTrackerModeStorage,
    type TrackerModeStorage,
  } from '$lib/tracker-mode-store';
  import ConnectedAccountPicker from './ConnectedAccountPicker.svelte';
  import Badge from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import Input from './ui/Input.svelte';
  import FormActions from './ui/FormActions.svelte';
  import RadioGroup from './ui/RadioGroup.svelte';

  interface Props {
    projectPath: string;
    storage?: TrackerModeStorage;
    connectedAccounts?: readonly ConnectedAccount[];
    onChange?: (mode: TrackerMode) => void;
  }

  const {
    projectPath,
    storage = createLocalStorageTrackerModeStorage(projectPath),
    connectedAccounts = [],
    onChange,
  }: Props = $props();

  // One-shot initial read into a plain local before seeding `$state`, same
  // pattern `McpServerConfigPanel.svelte`'s `readInitialRecords` uses —
  // referencing the `storage` prop directly inside a `$state` initializer
  // triggers Svelte 5's "only captures the initial value" warning.
  function readInitialMode(): TrackerMode | undefined {
    return storage.get();
  }

  const initialMode = readInitialMode();
  let savedMode = $state(initialMode);
  let editing = $state(initialMode === undefined);
  let draftKind = $state<TrackerModeKind | ''>(initialMode?.kind ?? '');
  let draftLive = $state<LiveTrackerDraft>(
    initialMode?.kind === 'live' ? liveTrackerDraftFrom(initialMode) : emptyLiveTrackerDraft(),
  );
  let error = $state<string | undefined>(undefined);

  function openEditor(): void {
    draftKind = savedMode?.kind ?? '';
    draftLive =
      savedMode?.kind === 'live' ? liveTrackerDraftFrom(savedMode) : emptyLiveTrackerDraft();
    error = undefined;
    editing = true;
  }

  /** Only reachable once a mode is already saved — the very first choice has no prior state to fall back to, so its own form never offers Cancel. */
  function cancelEditing(): void {
    editing = false;
    error = undefined;
  }

  function handleProviderChange(provider: string): void {
    // A fresh draft, not a partial reset: `connectionId`/target fields are
    // provider-scoped (a GitHub connectionId is meaningless once the
    // provider switches to Jira), so switching provider clears all of it
    // rather than leaving a stale, invisible value behind to resurface if
    // the user switches back.
    draftLive = emptyLiveTrackerDraft(provider as LiveProvider);
  }

  function handleSave(event: SubmitEvent): void {
    event.preventDefault();
    if (draftKind === '') {
      error = 'Choose native or live tracking before saving.';
      return;
    }
    const result = buildTrackerMode(draftKind, draftLive);
    if (result.error || !result.mode) {
      error = result.error ?? 'Invalid tracker configuration.';
      return;
    }
    storage.set(result.mode);
    savedMode = result.mode;
    editing = false;
    error = undefined;
    onChange?.(result.mode);
  }
</script>

<div class="tracker-config" data-testid="tracker-config-panel">
  {#if savedMode !== undefined && !editing}
    <Card elevation="raised" padding="md" class="config-section">
      <div class="mode-summary" data-testid="tracker-mode-summary">
        <Badge>{describeTrackerMode(savedMode)}</Badge>
        <Button variant="secondary" size="sm" onclick={openEditor} dataTestId="tracker-change-mode">
          Change tracker mode
        </Button>
      </div>
    </Card>
  {:else}
    <Card elevation="raised" padding="md" class="config-section">
      <form class="tracker-form" onsubmit={handleSave}>
        {#if error}
          <ErrorNotice message={error} />
        {/if}

        <Field label="Tracking mode" grouped required>
          {#snippet children({ labelId })}
            <RadioGroup
              value={draftKind}
              options={[
                {
                  value: 'native',
                  label: 'Native',
                  description: "loombox's own local tracker — no external account needed.",
                },
                {
                  value: 'live',
                  label: 'Live',
                  description: 'Work directly against a connected GitHub or Jira project.',
                },
              ]}
              onChange={(value) => (draftKind = value as TrackerModeKind)}
              labelledBy={labelId}
              dataTestId="tracker-mode"
            />
          {/snippet}
        </Field>

        {#if draftKind === 'live'}
          <Field label="Provider" grouped required>
            {#snippet children({ labelId })}
              <RadioGroup
                value={draftLive.provider}
                options={[
                  { value: 'github', label: 'GitHub' },
                  { value: 'jira', label: 'Jira' },
                ]}
                onChange={handleProviderChange}
                labelledBy={labelId}
                dataTestId="tracker-provider"
              />
            {/snippet}
          </Field>

          <Field label="Connected account" grouped required>
            <ConnectedAccountPicker
              provider={draftLive.provider}
              accounts={connectedAccounts}
              value={draftLive.connectionId || undefined}
              onChange={(connectionId) => (draftLive.connectionId = connectionId)}
              label="Connected account"
              dataTestId="tracker-connected-account"
            >
              {#snippet emptyStateCta()}
                <Button
                  variant="secondary"
                  size="sm"
                  onclick={() => (draftKind = 'native')}
                  dataTestId="tracker-use-native-instead"
                >
                  Use native mode instead
                </Button>
              {/snippet}
            </ConnectedAccountPicker>
          </Field>

          {#if draftLive.provider === 'github'}
            <Field label="Owner" required>
              {#snippet children({ id, describedBy, errorId, invalid, required })}
                <Input
                  {id}
                  {describedBy}
                  {errorId}
                  {invalid}
                  {required}
                  monospace
                  bind:value={draftLive.owner}
                  placeholder="loombox"
                  dataTestId="tracker-owner"
                />
              {/snippet}
            </Field>
            <Field label="Repository" required>
              {#snippet children({ id, describedBy, errorId, invalid, required })}
                <Input
                  {id}
                  {describedBy}
                  {errorId}
                  {invalid}
                  {required}
                  monospace
                  bind:value={draftLive.repo}
                  placeholder="loombox"
                  dataTestId="tracker-repo"
                />
              {/snippet}
            </Field>
            <Field label="Project board number" help="Optional — this repo's Projects v2 board.">
              {#snippet children({ id, describedBy, errorId, invalid, required })}
                <Input
                  {id}
                  {describedBy}
                  {errorId}
                  {invalid}
                  {required}
                  type="number"
                  bind:value={draftLive.projectNumber}
                  dataTestId="tracker-project-number"
                />
              {/snippet}
            </Field>
          {:else}
            <Field label="Jira cloud site id" required help="The Jira Cloud site's cloudId.">
              {#snippet children({ id, describedBy, errorId, invalid, required })}
                <Input
                  {id}
                  {describedBy}
                  {errorId}
                  {invalid}
                  {required}
                  monospace
                  bind:value={draftLive.cloudId}
                  dataTestId="tracker-cloud-id"
                />
              {/snippet}
            </Field>
            <Field label="Project key" required>
              {#snippet children({ id, describedBy, errorId, invalid, required })}
                <Input
                  {id}
                  {describedBy}
                  {errorId}
                  {invalid}
                  {required}
                  monospace
                  bind:value={draftLive.projectKey}
                  placeholder="LOOM"
                  dataTestId="tracker-project-key"
                />
              {/snippet}
            </Field>
          {/if}
        {/if}

        <FormActions>
          {#if savedMode !== undefined}
            <Button variant="secondary" onclick={cancelEditing} dataTestId="tracker-cancel">
              Cancel
            </Button>
          {/if}
          <Button type="submit" dataTestId="tracker-save">Save</Button>
        </FormActions>
      </form>
    </Card>
  {/if}
</div>

<style>
  .tracker-config {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .mode-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .tracker-form {
    display: flex;
    flex-direction: column;
    /* `Field` gaps its own label/control/help by `--space-3xs`; anything
       stacking `Field`s must beat that by at least `--space-sm` or nothing
       visually groups (`form-rhythm.spec.ts`'s contract, and the exact rule
       `AddTargetWizard.svelte`'s own `.host-form` documents). `--space-md`
       matches that form's and `NewSessionDialog`'s `.session-form`. */
    gap: var(--space-md);
  }
</style>
