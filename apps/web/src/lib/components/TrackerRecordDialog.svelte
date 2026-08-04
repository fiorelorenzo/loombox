<script lang="ts">
  /**
   * Create/edit form for one native tracker record (SPEC §7.10; issue
   * #212). Renders one `Field`+`Input` per role in `@loombox/protocol`'s
   * `TRACKER_ROLES`, gated on whether the CURRENTLY SELECTED type actually
   * maps that role — the same generic loop for a built-in Task/Bug/Epic
   * and any project-defined custom type, never a `primaryType`-keyed
   * branch (issue #212's "no per-type UI code" acceptance: switching the
   * Type field changes which fields render, purely by looking up that
   * type's own `roles`).
   *
   * `client` is a narrow slice of `RelayClient` (mirrors
   * `NewSessionDialog`'s `NewSessionClient`), not the real client itself,
   * so a component test injects a plain fake with no crypto/WebSocket
   * machinery. Every write goes through it — never local component state
   * — exactly like every other dialog in this package that commits
   * something real.
   */
  import {
    TRACKER_ROLES,
    type TrackerRecordV1,
    type TrackerRoleV1,
    type TrackerTypeDefinitionV1,
  } from '@loombox/protocol';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import FormActions from './ui/FormActions.svelte';
  import Input from './ui/Input.svelte';
  import Select from './ui/Select.svelte';

  export interface TrackerRecordClient {
    createTrackerRecord: (input: {
      primaryType: string;
      fields: Record<string, unknown>;
    }) => Promise<TrackerRecordV1>;
    updateTrackerRecord: (
      id: string,
      patch: { fields?: Record<string, unknown> },
    ) => Promise<TrackerRecordV1>;
  }

  const ROLE_LABELS: Record<TrackerRoleV1, string> = {
    title: 'Title',
    workflowStatus: 'Status',
    priority: 'Priority',
    assignee: 'Assignee',
  };

  interface Props {
    open: boolean;
    client: TrackerRecordClient;
    types: TrackerTypeDefinitionV1[];
    /** `undefined` — create mode. Set — edit mode, pre-filled from this record. */
    record?: TrackerRecordV1;
    onClose: () => void;
    onSaved: (record: TrackerRecordV1) => void;
  }

  const { open, client, types, record, onClose, onSaved }: Props = $props();

  let primaryType = $state('');
  let roleValues = $state<Partial<Record<TrackerRoleV1, string>>>({});
  let submitting = $state(false);
  let submitError = $state<string | undefined>(undefined);

  // Resets every time the dialog actually opens (mirrors `AddProjectDialog`'s
  // identical "open is this effect's only reactive read" convention), so
  // re-opening for a different record never shows the previous one mid-flash.
  $effect(() => {
    if (!open) return;
    primaryType = record?.primaryType ?? types[0]?.id ?? '';
    const seeded: Partial<Record<TrackerRoleV1, string>> = {};
    if (record) {
      const type = types.find((candidate) => candidate.id === record.primaryType);
      for (const role of TRACKER_ROLES) {
        const key = type?.roles[role];
        const value = key === undefined ? undefined : record.fields[key];
        if (typeof value === 'string') seeded[role] = value;
      }
    }
    roleValues = seeded;
    submitError = undefined;
  });

  const selectedType = $derived(types.find((candidate) => candidate.id === primaryType));
  const typeOptions = $derived(types.map((type) => ({ id: type.id, label: type.label })));
  const visibleRoles = $derived(
    TRACKER_ROLES.filter((role) => selectedType?.roles[role] !== undefined),
  );

  function roleValue(role: TrackerRoleV1): string {
    return roleValues[role] ?? '';
  }

  function setRoleValue(role: TrackerRoleV1, value: string): void {
    roleValues = { ...roleValues, [role]: value };
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const type = selectedType;
    if (!type) {
      submitError = 'Choose a type first.';
      return;
    }
    submitting = true;
    submitError = undefined;
    try {
      const fields: Record<string, unknown> = record ? { ...record.fields } : {};
      for (const role of TRACKER_ROLES) {
        const key = type.roles[role];
        if (key === undefined) continue;
        fields[key] = roleValue(role);
      }
      const saved = record
        ? await client.updateTrackerRecord(record.id, { fields })
        : await client.createTrackerRecord({ primaryType: type.id, fields });
      onSaved(saved);
      onClose();
    } catch (error) {
      submitError = error instanceof Error ? error.message : String(error);
    } finally {
      submitting = false;
    }
  }
</script>

{#snippet dialogBody()}
  <form class="tracker-record-form" onsubmit={handleSubmit}>
    <Field label="Type" grouped>
      <Select
        label="Type"
        value={primaryType}
        options={typeOptions}
        onChange={(id) => (primaryType = id)}
        dataTestId="tracker-record-type"
      />
    </Field>

    {#each visibleRoles as role (role)}
      <Field label={ROLE_LABELS[role]}>
        {#snippet children({ id, describedBy })}
          <Input
            {id}
            {describedBy}
            value={roleValue(role)}
            oninput={(event) => setRoleValue(role, event.currentTarget.value)}
            dataTestId={`tracker-record-${role}`}
          />
        {/snippet}
      </Field>
    {/each}

    {#if submitError}
      <ErrorNotice message={submitError} />
    {/if}

    <FormActions>
      <Button variant="secondary" onclick={onClose}>Cancel</Button>
      <Button type="submit" variant="primary" loading={submitting} disabled={!selectedType}>
        {record ? 'Save' : 'Create'}
      </Button>
    </FormActions>
  </form>
{/snippet}

<Dialog
  {open}
  label={record ? 'Edit record' : 'New record'}
  onClose={submitting ? () => {} : onClose}
  size="md"
  children={dialogBody}
>
  {#snippet header()}
    <h2>{record ? 'Edit record' : 'New record'}</h2>
  {/snippet}
</Dialog>

<style>
  .tracker-record-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }
</style>
