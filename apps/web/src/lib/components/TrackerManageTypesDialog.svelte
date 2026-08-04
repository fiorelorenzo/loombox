<script lang="ts">
  /**
   * Lists every tracker type this project knows about — the three built-ins
   * plus any project-defined custom type — and is the sole place "New type"
   * now lives (v7 decision F3-1; issue #673). Replaces the old always-on
   * "New type" button that used to sit right next to "New record" in the
   * Tracker page header: the machinery only shows up once someone
   * explicitly opens this.
   *
   * This is also the actual fix for the v7 review's "write-only form"
   * complaint. The old standalone define-type dialog only ever rendered a
   * blank create form — nothing in the app showed a type back once you'd
   * defined it, so from a user's chair the form "forgot" what they told it
   * even though `NativeTrackerStore` persisted it correctly the whole time
   * (see that store's `defineType`/`listTypes` — the gap was purely a
   * missing UI surface, not the storage layer). This dialog renders
   * whatever `types` the caller's own live snapshot currently holds — the
   * exact same list `TrackerRecordDialog`'s Type dropdown reads — so a type
   * defined here is visible here again the next time this opens, and
   * survives a reload the same way a created record does (both round-trip
   * through `NativeTrackerStore` on the node and
   * `RelayClient.trackerSnapshotFor` on the client).
   *
   * A single `Dialog` with an internal `view` step (`'list'` / `'define'`),
   * mirroring `AddTargetWizard`'s own single-panel, multi-step convention
   * — never two separate `Dialog`s swapped in and out, which would either
   * stack two dimmed backdrops mid-transition or need a fragile handoff
   * between them. "Cancel" from the define step goes back to the list, not
   * out of the dialog entirely; only the panel's own close (Esc/backdrop
   * click) calls `onClose`.
   */
  import {
    TRACKER_ROLES,
    type TrackerRoleV1,
    type TrackerTypeDefinitionV1,
  } from '@loombox/protocol';
  import Badge from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import FormActions from './ui/FormActions.svelte';
  import Input from './ui/Input.svelte';
  import Row from './ui/Row.svelte';

  export interface TrackerTypeClient {
    defineTrackerType: (type: {
      id: string;
      label: string;
      roles: Partial<Record<TrackerRoleV1, string>>;
    }) => Promise<TrackerTypeDefinitionV1>;
  }

  const ROLE_LABELS: Record<TrackerRoleV1, string> = {
    title: 'Title field',
    workflowStatus: 'Status field',
    priority: 'Priority field',
    assignee: 'Assignee field',
  };

  interface Props {
    open: boolean;
    client: TrackerTypeClient;
    /** Built-ins plus this project's own custom types — the same list `TrackerRecordDialog` receives, read from the caller's live snapshot store rather than fetched separately, so this list and the record form's Type dropdown can never disagree. */
    types: TrackerTypeDefinitionV1[];
    onClose: () => void;
    onDefined: (type: TrackerTypeDefinitionV1) => void;
  }

  const { open, client, types, onClose, onDefined }: Props = $props();

  type View = 'list' | 'define';
  let view = $state<View>('list');

  let id = $state('');
  let label = $state('');
  let roleFieldKeys = $state<Partial<Record<TrackerRoleV1, string>>>({});
  let submitting = $state(false);
  let submitError = $state<string | undefined>(undefined);

  // Every time the dialog actually opens, start back on the list — a
  // previous session's half-filled "New type" form never survives to the
  // next open (mirrors `TrackerRecordDialog`'s identical "open is this
  // effect's only reactive read" convention).
  $effect(() => {
    if (!open) return;
    view = 'list';
  });

  function openDefineForm(): void {
    id = '';
    label = '';
    roleFieldKeys = {};
    submitError = undefined;
    view = 'define';
  }

  function roleFieldKey(role: TrackerRoleV1): string {
    return roleFieldKeys[role] ?? '';
  }

  function setRoleFieldKey(role: TrackerRoleV1, value: string): void {
    roleFieldKeys = { ...roleFieldKeys, [role]: value };
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const trimmedId = id.trim();
    const trimmedLabel = label.trim();
    if (!trimmedId || !trimmedLabel) {
      submitError = 'A type needs both an id and a label.';
      return;
    }
    if (types.some((existing) => existing.id === trimmedId)) {
      submitError = `"${trimmedId}" is already a tracker type in this project.`;
      return;
    }
    const roles: Partial<Record<TrackerRoleV1, string>> = {};
    for (const role of TRACKER_ROLES) {
      const key = roleFieldKey(role).trim();
      if (key.length > 0) roles[role] = key;
    }

    submitting = true;
    submitError = undefined;
    try {
      const defined = await client.defineTrackerType({ id: trimmedId, label: trimmedLabel, roles });
      onDefined(defined);
      view = 'list';
    } catch (error) {
      submitError = error instanceof Error ? error.message : String(error);
    } finally {
      submitting = false;
    }
  }
</script>

{#snippet listView()}
  <ul class="tracker-type-list" data-testid="tracker-manage-types-list">
    {#each types as type (type.id)}
      <li>
        <Row as="div" surface dataTestId={`tracker-type-row-${type.id}`}>
          <span class="tracker-type-label">{type.label}</span>
          {#if type.builtin}
            <Badge size="sm">Built in</Badge>
          {/if}
          {#snippet trailing()}
            <span class="tracker-type-roles font-mono">{Object.keys(type.roles).join(' · ')}</span>
          {/snippet}
        </Row>
      </li>
    {/each}
  </ul>
  <div class="tracker-type-list-footer">
    <Button variant="secondary" size="sm" onclick={openDefineForm}>New type</Button>
  </div>
{/snippet}

{#snippet defineView()}
  <form class="tracker-define-type-form" onsubmit={handleSubmit}>
    <Field
      label="Id"
      help="A stable slug — never shown to users, used to store which type each record has."
    >
      {#snippet children({ id: fieldId, describedBy })}
        <Input
          id={fieldId}
          {describedBy}
          value={id}
          oninput={(event) => (id = event.currentTarget.value)}
          monospace
          dataTestId="tracker-define-type-id"
        />
      {/snippet}
    </Field>

    <Field label="Label">
      {#snippet children({ id: fieldId, describedBy })}
        <Input
          id={fieldId}
          {describedBy}
          value={label}
          oninput={(event) => (label = event.currentTarget.value)}
          dataTestId="tracker-define-type-label"
        />
      {/snippet}
    </Field>

    {#each TRACKER_ROLES as role (role)}
      <Field
        label={ROLE_LABELS[role]}
        help={`Leave blank if this type has no ${role === 'workflowStatus' ? 'status' : role}.`}
      >
        {#snippet children({ id: fieldId, describedBy })}
          <Input
            id={fieldId}
            {describedBy}
            value={roleFieldKey(role)}
            oninput={(event) => setRoleFieldKey(role, event.currentTarget.value)}
            monospace
            dataTestId={`tracker-define-type-role-${role}`}
          />
        {/snippet}
      </Field>
    {/each}

    {#if submitError}
      <ErrorNotice message={submitError} />
    {/if}

    <FormActions>
      <Button variant="secondary" onclick={() => (view = 'list')}>Cancel</Button>
      <Button type="submit" variant="primary" loading={submitting}>Create type</Button>
    </FormActions>
  </form>
{/snippet}

<Dialog
  {open}
  label={view === 'list' ? 'Manage tracker types' : 'New tracker type'}
  onClose={submitting ? () => {} : onClose}
  size="md"
  children={view === 'list' ? listView : defineView}
>
  {#snippet header()}
    <h2>{view === 'list' ? 'Manage types' : 'New tracker type'}</h2>
  {/snippet}
</Dialog>

<style>
  .tracker-type-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .tracker-type-label {
    font-weight: 600;
  }

  .tracker-type-roles {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .tracker-type-list-footer {
    display: flex;
    justify-content: flex-end;
  }

  .tracker-define-type-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }
</style>
