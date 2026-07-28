<script lang="ts">
  /**
   * The one-time "pick the folder" step (design spec §3.4, §4.2; issue
   * #507): before this dialog existed, a project's folder was re-picked on
   * every single session creation (`NewSessionDialog`'s own `TargetPicker`
   * + `DirectoryPicker`) because `Project` (`$lib/projects`) didn't exist
   * yet: it was just a `projectPath` string buried inside a session's
   * private envelope. This dialog is where a project is actually born: it
   * picks a target and a folder ONCE, then hands a plain `NewProject` back
   * via `onCreated` for the caller to register. Deliberately pure, like
   * `NewSessionDialog`: it never touches the project store itself
   * (component boundary, design spec §4.3), so it stays testable without a
   * real store and the shell stays the one place a project is actually
   * committed.
   *
   * `targets` arrives as a plain prop rather than a self-managed fetch: the
   * shell already polls `listTargets()` continuously from the moment it
   * connects (`+page.svelte`'s `refreshTargetStatus`/
   * `startTargetStatusPolling`, issue #269) for the header health dot and
   * the Nodes page, so a second, independent fetch/loading/error cycle
   * here would just be a slower, out-of-sync copy of state the shell
   * already has. `client` is still needed directly, narrowed to
   * `DirectoryPickerClient` (not the full `RelayClient`) purely for
   * `browseDirectory`, the same hermetic-test narrowing every other
   * dialog in this package uses.
   *
   * The name field defaults to `projectNameFromPath(path)` and keeps
   * following the path as the user browses, right up until they type into
   * the field themselves: `nameEdited` latches permanently once that
   * happens (never re-armed for the rest of this open dialog), because
   * silently overwriting a name someone just typed the moment they browse
   * one level further is the kind of "helpful" default that actually just
   * loses your work.
   *
   * `isGitRepo` is whatever `DirectoryPicker`'s own `onChange` last
   * reported for the CURRENT path (`undefined` for a manually-typed,
   * not-yet-browsed path; see that component's own doc comment), never
   * independently probed here, since browsing IS the probe.
   */
  import type { NewProject } from '$lib/projects';
  import { projectNameFromPath } from '$lib/projects';
  import type { TargetListEntry } from '$lib/relay-client';
  import DirectoryPicker, { type DirectoryPickerClient } from './DirectoryPicker.svelte';
  import TargetPicker from './TargetPicker.svelte';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import FormActions from './ui/FormActions.svelte';
  import Input from './ui/Input.svelte';

  interface Props {
    open: boolean;
    targets: TargetListEntry[];
    client: DirectoryPickerClient | undefined;
    onClose: () => void;
    onCreated: (project: NewProject) => void;
  }

  const { open, targets, client, onClose, onCreated }: Props = $props();

  let selectedTargetId = $state<string | undefined>(undefined);
  let path = $state('');
  let isGitRepo = $state<boolean | undefined>(undefined);
  let name = $state('');
  let nameEdited = $state(false);
  /** True while the submit-time git-status probe is in flight, so the button can show progress and a double submit cannot fire two probes. */
  let submitting = $state(false);
  /** A submit-time failure from that probe (unreadable path, unreachable target); cleared on every fresh attempt. */
  let submitError = $state<string | undefined>(undefined);

  /** The selected target's own `nodeId`: `DirectoryPicker`'s other routing half alongside `selectedTargetId` (`RelayClient.browseDirectory`'s `nodeId`+`targetId` pair). */
  const selectedNodeId = $derived(
    targets.find((target) => target.targetId === selectedTargetId)?.nodeId,
  );

  /** Whether `DirectoryPicker` can actually browse anything yet — the same gate `DirectoryPicker` itself uses internally, mirrored here so `Field`'s `help` can explain why the folder control is disabled rather than leaving it a mystery. */
  const directoryPickerReady = $derived(
    client !== undefined && selectedNodeId !== undefined && selectedTargetId !== undefined,
  );

  const canSubmit = $derived(selectedTargetId !== undefined && path.trim() !== '');

  // Resets every time the dialog actually opens, mirroring `NewSessionDialog`'s
  // identical "open is this effect's only reactive read" convention, so
  // re-opening for a second folder never shows the previous pick mid-flash.
  $effect(() => {
    if (!open) return;
    resetForm();
  });

  // Picks a default target once `targets` is actually non-empty, without
  // ever clobbering an explicit click. Kept separate from the reset
  // effect above because `targets` is the shell's own continuously-polled
  // list (see the file doc comment) and can easily still be `[]` at the
  // instant `open` flips true, arriving a beat later.
  $effect(() => {
    if (!open || selectedTargetId !== undefined) return;
    const firstReachable = targets.find((target) => target.reachable);
    selectedTargetId = firstReachable?.targetId ?? targets[0]?.targetId;
  });

  function resetForm(): void {
    selectedTargetId = undefined;
    path = '';
    isGitRepo = undefined;
    name = '';
    nameEdited = false;
    submitting = false;
    submitError = undefined;
  }

  function handleTargetChange(targetId: string): void {
    // A path already browsed on the PREVIOUS target belongs to a different
    // filesystem entirely (`projectKey`'s own "same path on two targets is
    // two different projects" rule): carrying it over would silently
    // register the wrong project, so switching targets clears the folder
    // pick same as a fresh open would.
    selectedTargetId = targetId;
    path = '';
    isGitRepo = undefined;
    name = '';
    nameEdited = false;
    submitError = undefined;
  }

  function handleDirectoryChange(newPath: string, gitRepo: boolean | undefined): void {
    path = newPath;
    isGitRepo = gitRepo;
    if (!nameEdited) name = projectNameFromPath(newPath);
  }

  function handleNameInput(event: Event & { currentTarget: HTMLInputElement }): void {
    name = event.currentTarget.value;
    nameEdited = true;
  }

  /**
   * Resolves the folder's git status before registering the project, so
   * `NewProject.isGitRepo` is a known boolean at every call site (design spec
   * "Workspace: no backward compatibility").
   *
   * `DirectoryPicker` only reports git status after a real `browseDirectory`
   * round trip, so a path the operator TYPED rather than browsed to arrives
   * here unknown. Leaving it unknown is not harmless: `NewSessionDialog` shows
   * the isolated-worktree choice only for a repo, so a typed path would
   * silently lose that option on a project that genuinely is one. One probe on
   * submit closes that hole and doubles as the folder validation this dialog
   * never had - a path that cannot be listed is not a project worth
   * registering, so a failure surfaces here instead of at session start.
   */
  async function handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSubmit || !selectedTargetId || submitting) return;
    const target = targets.find((entry) => entry.targetId === selectedTargetId);
    if (!target) return;
    const trimmedPath = path.trim();

    let resolvedIsGitRepo = isGitRepo;
    if (resolvedIsGitRepo === undefined) {
      if (!client) return;
      submitting = true;
      submitError = undefined;
      try {
        const result = await client.browseDirectory({
          nodeId: target.nodeId,
          targetId: target.targetId,
          path: trimmedPath,
        });
        if (result.outcome !== 'ok') {
          submitError = `Could not read ${trimmedPath} on ${target.label ?? target.targetId}. Check the path and try again.`;
          return;
        }
        // An `ok` reply that simply omits `gitRepo` leaves the flag unknown
        // rather than blocking: the folder demonstrably READS, which is all
        // this probe gates on. Unknown is a value `Project.isGitRepo`
        // documents and handles (the worktree radio hides, the node's own
        // per-target default decides), so inventing `false` here - or
        // refusing a perfectly good folder - would both be worse.
        resolvedIsGitRepo = result.gitRepo;
      } catch {
        submitError = `Could not reach ${target.label ?? target.targetId} to check that folder. Try again once it is back.`;
        return;
      } finally {
        submitting = false;
      }
    }

    onCreated({
      name: name.trim() || undefined,
      nodeId: target.nodeId,
      targetId: target.targetId,
      path: trimmedPath,
      isGitRepo: resolvedIsGitRepo,
    });
    onClose();
  }

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet dialogBody()}
  <form class="project-form" onsubmit={handleSubmit}>
    {#if targets.length === 0}
      <div class="empty-state-slot" data-testid="add-project-no-targets">
        <EmptyState message="No nodes connected yet: start a loombox node pointed at this relay." />
      </div>
    {:else}
      <Field label="Target" grouped>
        <TargetPicker {targets} value={selectedTargetId} onChange={handleTargetChange} />
      </Field>
    {/if}

    <Field
      label="Project folder"
      grouped
      help={directoryPickerReady ? undefined : 'Pick a target to browse its folders.'}
    >
      {#snippet children({ labelId, describedBy })}
        <div role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
          <DirectoryPicker
            {client}
            nodeId={selectedNodeId}
            targetId={selectedTargetId}
            value={path}
            onChange={handleDirectoryChange}
            inputTestId="add-project-path"
          />
        </div>
      {/snippet}
    </Field>

    <Field label="Name" help="Defaults to the folder name">
      {#snippet children({ id, describedBy })}
        <Input
          {id}
          {describedBy}
          value={name}
          oninput={handleNameInput}
          dataTestId="add-project-name"
        />
      {/snippet}
    </Field>

    {#if submitError}
      <ErrorNotice message={submitError} />
    {/if}

    <FormActions>
      <Button variant="secondary" onclick={handleClose}>Cancel</Button>
      <Button
        type="submit"
        variant="primary"
        disabled={!canSubmit}
        loading={submitting}
        dataTestId="add-project-submit"
      >
        Add project
      </Button>
    </FormActions>
  </form>
{/snippet}

<Dialog {open} label="Add project" onClose={handleClose} size="md" children={dialogBody}>
  {#snippet header()}
    <h2>Add project</h2>
  {/snippet}
</Dialog>

<style>
  .empty-state-slot {
    border-radius: var(--radius-lg);
    background: var(--color-fill-subtle);
  }

  .project-form {
    display: flex;
    flex-direction: column;
    /* Above `Field`'s own label-to-control gap, so the pairs group — see
       `ui/Field.svelte`'s note on that contract. */
    gap: var(--space-md);
  }
</style>
