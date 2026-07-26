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

  /** The selected target's own `nodeId`: `DirectoryPicker`'s other routing half alongside `selectedTargetId` (`RelayClient.browseDirectory`'s `nodeId`+`targetId` pair). */
  const selectedNodeId = $derived(
    targets.find((target) => target.targetId === selectedTargetId)?.nodeId,
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

  function handleSubmit(event: Event): void {
    event.preventDefault();
    if (!canSubmit || !selectedTargetId) return;
    const target = targets.find((entry) => entry.targetId === selectedTargetId);
    if (!target) return;
    onCreated({
      name: name.trim() || undefined,
      nodeId: target.nodeId,
      targetId: target.targetId,
      path: path.trim(),
      isGitRepo,
    });
    onClose();
  }

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet dialogBody()}
  {#if targets.length === 0}
    <div class="empty-state-slot" data-testid="add-project-no-targets">
      <EmptyState message="No nodes connected yet: start a loombox node pointed at this relay." />
    </div>
  {:else}
    <TargetPicker {targets} value={selectedTargetId} onChange={handleTargetChange} />
  {/if}

  <form class="project-form" onsubmit={handleSubmit}>
    <span class="field-label" id="add-project-path-label">Project folder</span>
    <div role="group" aria-labelledby="add-project-path-label">
      <DirectoryPicker
        {client}
        nodeId={selectedNodeId}
        targetId={selectedTargetId}
        value={path}
        onChange={handleDirectoryChange}
        inputTestId="add-project-path"
      />
    </div>

    <label for="add-project-name">Name</label>
    <input
      id="add-project-name"
      type="text"
      placeholder="Defaults to the folder name"
      value={name}
      oninput={handleNameInput}
      data-testid="add-project-name"
    />

    <div class="actions">
      <Button variant="secondary" onclick={handleClose}>Cancel</Button>
      <Button type="submit" variant="primary" disabled={!canSubmit} dataTestId="add-project-submit">
        Add project
      </Button>
    </div>
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
    gap: var(--space-2xs);
  }

  .project-form label,
  .project-form .field-label {
    display: block;
    margin-top: var(--space-xs);
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .project-form input {
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: inherit;
    font-family: inherit;
    font-size: var(--text-body-size);
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .project-form input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
    margin-top: var(--space-sm);
  }
</style>
