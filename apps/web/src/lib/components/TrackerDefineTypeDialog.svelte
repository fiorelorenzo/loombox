<script lang="ts">
  /**
   * Registers a project-defined custom tracker type (SPEC §7.10; issue
   * #212): an id, a label, and — for each of `@loombox/protocol`'s
   * `TRACKER_ROLES` — which `fields` key (if any) holds that role for a
   * record of this type. This mapping is the whole mechanism issue #212's
   * "no per-type UI code" acceptance rests on: once saved, every generic
   * role-driven surface (`TrackerBoard`, `TrackerListView`,
   * `TrackerRecordDialog`) renders records of this type exactly like a
   * built-in one, purely by looking `roles` up — nothing here, or
   * anywhere else in this feature, branches on a type's `id`.
   */
  import {
    TRACKER_ROLES,
    type TrackerRoleV1,
    type TrackerTypeDefinitionV1,
  } from '@loombox/protocol';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import FormActions from './ui/FormActions.svelte';
  import Input from './ui/Input.svelte';

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
    /** Every id already in use (built-ins plus existing custom types) — client-side collision guard so a mistake surfaces before the round trip, mirroring `NativeTrackerStore.defineType`'s own server-side check. */
    existingTypeIds: string[];
    onClose: () => void;
    onDefined: (type: TrackerTypeDefinitionV1) => void;
  }

  const { open, client, existingTypeIds, onClose, onDefined }: Props = $props();

  let id = $state('');
  let label = $state('');
  let roleFieldKeys = $state<Partial<Record<TrackerRoleV1, string>>>({});
  let submitting = $state(false);
  let submitError = $state<string | undefined>(undefined);

  $effect(() => {
    if (!open) return;
    id = '';
    label = '';
    roleFieldKeys = {};
    submitError = undefined;
  });

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
    if (existingTypeIds.includes(trimmedId)) {
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
      onClose();
    } catch (error) {
      submitError = error instanceof Error ? error.message : String(error);
    } finally {
      submitting = false;
    }
  }
</script>

{#snippet dialogBody()}
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
      <Button variant="secondary" onclick={onClose}>Cancel</Button>
      <Button type="submit" variant="primary" loading={submitting}>Create type</Button>
    </FormActions>
  </form>
{/snippet}

<Dialog
  {open}
  label="New tracker type"
  onClose={submitting ? () => {} : onClose}
  size="md"
  children={dialogBody}
>
  {#snippet header()}
    <h2>New tracker type</h2>
  {/snippet}
</Dialog>

<style>
  .tracker-define-type-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }
</style>
