<script lang="ts">
  /**
   * The "New session" flow (SPEC §7.1; issue #385): creates a session via
   * `RelayClient.createSession` and hands the new session id back so the
   * caller can open it.
   *
   * `client` is typed to the narrow `NewSessionClient` interface (not the
   * full `RelayClient`) so a hermetic component test can inject a fake
   * without spinning up a real relay: mirrors `InteractiveTerminal.svelte`'s
   * own narrowed-client pattern elsewhere in this package. `undefined`
   * (not yet connected) disables the submit button but still mounts,
   * matching `open`'s own gate (`+page.svelte` only ever passes a defined
   * `client` once `status === 'open'` in practice).
   *
   * IA v4 rewrite (design spec §3.4; issue #507): every session now belongs
   * to an already-registered `Project` (`$lib/projects`), so this dialog no
   * longer asks for a target or a folder. That used to be `TargetPicker` +
   * `DirectoryPicker` here, re-picked on every single creation; both moved
   * to `AddProjectDialog`, which fixes them ONCE per folder. This dialog
   * now only ever reads them off `project`, shown as a muted read-only
   * context line rather than form fields, and asks what's genuinely
   * per-session: an agent, SPEC §7.1's per-session worktree choice, a
   * title, and a starting prompt. That split is also what unblocks the
   * worktree choice at all: it had no `session_create` field to travel in
   * before this change (closed in the same change, `packages/protocol`'s
   * `sessionPrivateMetaV1.worktree`), and it only ever makes sense
   * per-session, never per-project.
   *
   * `project.isGitRepo` decides whether the Workspace control renders at
   * all: `true` shows it, `false` (confirmed not a repo) omits it outright,
   * and `undefined` (an adopted project nobody has ever browsed to, or one
   * registered before this field existed) is genuinely unknown rather than
   * `false`, so this dialog resolves it itself on open via one
   * `browseDirectory` call against the project's own path, the same source
   * `AddProjectDialog`/`DirectoryPicker` read `gitRepo` from. A failed
   * probe or an older node that omits the field both leave it unknown: the
   * control stays hidden and no `worktree` field is sent at all, which per
   * `CreateSessionOptions.worktree`'s own doc comment leaves the node's
   * per-target default in charge rather than guessing here.
   * `onGitRepoResolved` reports a definitively-learned value back up so the
   * caller can persist it (`ProjectStore.setGitRepo`) and skip this same
   * probe next time; omitted, the dialog still works, it just re-probes on
   * every open.
   *
   * The probe is kicked off from its OWN `$effect`, separate from the one
   * that resets the form on open, and deliberately never resets anything:
   * if the caller echoes a resolved `isGitRepo` back through an updated
   * `project` prop while this dialog is still open (e.g. after
   * `onGitRepoResolved` round-trips through the project store), that must
   * only ever stop the probe from re-firing, never wipe a title/prompt the
   * user has already started typing.
   *
   * Deck migration (redesign v2 §2 "One button language", issue #464):
   * every hand-rolled `.btn*` gives way to the shared `Button` primitive.
   * Deck v3 restyle (redesign v3 design spec §3.5, issue #502): the Agent
   * field's native `<select>` gives way to the shared `ui/Select` primitive.
   *
   * Coherence v5 migration (design spec §1, issue #508): the Agent,
   * Workspace, Title, and Starting-prompt fields, and the actions row,
   * now go through the shared `Field`/`Input`/`TextArea`/`RadioGroup`/
   * `FormActions` primitives instead of each hand-rolling its own label,
   * input/textarea styling, radio-card markup, and action-row layout —
   * see `Field.svelte`'s own doc comment, which cites this file's
   * pre-migration Agent-field-vs-Title-field inconsistency as its
   * motivating example.
   */
  import type { CreateSessionOptions } from '$lib/relay-client';
  import type { Project } from '$lib/projects';
  import type { DirectoryPickerClient } from './DirectoryPicker.svelte';
  import WovenLoader from './WovenLoader.svelte';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import FormActions from './ui/FormActions.svelte';
  import Input from './ui/Input.svelte';
  import RadioGroup, { type RadioOption } from './ui/RadioGroup.svelte';
  import Select, { type SelectOption } from './ui/Select.svelte';
  import TextArea from './ui/TextArea.svelte';

  export interface NewSessionClient extends DirectoryPickerClient {
    createSession: (options: CreateSessionOptions) => Promise<string>;
  }

  interface Props {
    open: boolean;
    project: Project;
    client: NewSessionClient | undefined;
    onClose: () => void;
    onCreated: (sessionId: string) => void;
    /** Reports a definitively-learned `isGitRepo` once this dialog had to probe for it itself (`project.isGitRepo` was `undefined`); see the file doc comment. Only ever called with a real `true`/`false`, never for a failed or inconclusive probe. */
    onGitRepoResolved?: (isGitRepo: boolean) => void;
  }

  const { open, project, client, onClose, onCreated, onGitRepoResolved }: Props = $props();

  /** The only agent option today (SPEC's locked "Claude-only" v1 call), shown as a real `Select` rather than hidden, so the field is honest about being extensible later without pretending there's a choice yet. */
  const PROVIDER_OPTIONS: SelectOption[] = [{ id: 'claude', label: 'Claude Code' }];
  let selectedProvider = $state('claude');
  type WorkspaceChoice = 'worktree' | 'in-place';
  let workspaceChoice = $state<WorkspaceChoice>('worktree');

  /** SPEC §7.1's two per-session choices — see `RadioGroup.svelte`'s own doc comment for why these render as description-bearing cards, not bare native radios. */
  const WORKSPACE_OPTIONS: RadioOption[] = [
    {
      value: 'worktree',
      label: 'Isolated worktree',
      description:
        'A fresh branch under .loombox/worktrees/, so several agents can work on this project at once.',
    },
    {
      value: 'in-place',
      label: 'In place',
      description: 'Directly in the project folder. Only one session at a time can do this.',
    },
  ];

  let title = $state('');
  let prompt = $state('');
  let creating = $state(false);
  let createError = $state<string | undefined>(undefined);

  /** A definitively-learned `isGitRepo`, once this dialog's own probe resolves: `undefined` until then, and forever if the probe fails or the node omits the field (both mean "still unknown", never "false"). */
  let probedIsGitRepo = $state<boolean | undefined>(undefined);
  let probing = $state(false);
  /** Flips once the probe attempt finishes, success or not, so `resolvingWorkspace` below knows to stop showing the loading state even when `probedIsGitRepo` stayed unknown. */
  let probeSettled = $state(false);

  /** `project.isGitRepo` wins whenever it's known; the local probe result only ever fills in for as long as it stays `undefined`. */
  const effectiveIsGitRepo = $derived(project.isGitRepo ?? probedIsGitRepo);
  const resolvingWorkspace = $derived(project.isGitRepo === undefined && !probeSettled);

  // Resets the per-session fields every time the dialog actually opens.
  // This effect's ONLY reactive read is `open`, deliberately never
  // `project`/`client` (see the file doc comment's "never resets anything"
  // paragraph above): re-opening for the same or a different project must
  // never look mid-session-typing like a stale re-render.
  $effect(() => {
    if (!open) return;
    resetForm();
  });

  // Kicks off the `isGitRepo` probe once `open` and `client` are both
  // ready, but ONLY takes action: never resets `probing`/`probeSettled`
  // itself, so a `project` prop update this dialog's own probe indirectly
  // caused (the `onGitRepoResolved` round trip) just finds the guards
  // already tripped and no-ops, rather than re-probing in a loop.
  $effect(() => {
    if (!open || !client) return;
    if (project.isGitRepo !== undefined) return;
    if (probing || probeSettled) return;
    void probeGitRepo();
  });

  async function probeGitRepo(): Promise<void> {
    if (!client) return;
    probing = true;
    try {
      const result = await client.browseDirectory({
        nodeId: project.nodeId,
        targetId: project.targetId,
        path: project.path,
      });
      if (result.outcome === 'ok' && result.gitRepo !== undefined) {
        probedIsGitRepo = result.gitRepo;
        onGitRepoResolved?.(result.gitRepo);
      }
      // A `{outcome:'error'}` reply, or an `ok` one that simply omits
      // `gitRepo` (an older node), both leave `probedIsGitRepo` unknown:
      // the Workspace control stays hidden and no `worktree` field is ever
      // sent, per this file's own doc comment.
    } catch (error) {
      console.warn(
        'NewSessionDialog: failed to resolve whether the project folder is a git repository',
        project.path,
        error,
      );
    } finally {
      probing = false;
      probeSettled = true;
    }
  }

  const canSubmit = $derived(!creating && client !== undefined && prompt.trim() !== '');

  async function handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (!client || !canSubmit) return;
    creating = true;
    createError = undefined;
    try {
      const sessionId = await client.createSession({
        targetId: project.targetId,
        provider: selectedProvider,
        projectPath: project.path,
        // Only a CONFIRMED git repo ever gets a `worktree` value at all:
        // when the folder isn't a repo, or that's still unknown, there is
        // no genuine per-session choice to send (see `effectiveIsGitRepo`).
        ...(effectiveIsGitRepo === true ? { worktree: workspaceChoice === 'worktree' } : {}),
        title: title.trim() || undefined,
        prompt: prompt.trim(),
      });
      onCreated(sessionId);
      onClose();
    } catch (error) {
      // Same wire-identifier leak issue #505 fixed in `DirectoryPicker` and
      // `ArchiveSessionDialog`, but the honest wording is the opposite one.
      // A timeout here does NOT mean nothing happened: the node creates the
      // session's worktree first and only announces it once the agent is
      // ready, and bringing an agent up can outlast this wait (a cold
      // `npm exec` of the provider package, a loaded machine). So the
      // session is quite likely on its way and will appear on the board by
      // itself - telling the user it failed would be the wrong lie in the
      // other direction. Every other error is written for a human by the
      // node already and is shown verbatim; the real message still reaches a
      // developer via `console.warn`.
      console.warn('NewSessionDialog: createSession failed', error);
      const raw = error instanceof Error ? error.message : String(error);
      createError = raw.includes('timed out waiting')
        ? 'The agent is taking a while to start. The session may still appear on its own in a moment; if it does not, the node may be offline.'
        : raw;
    } finally {
      creating = false;
    }
  }

  function resetForm(): void {
    selectedProvider = 'claude';
    workspaceChoice = 'worktree';
    title = '';
    prompt = '';
    creating = false;
    createError = undefined;
    probedIsGitRepo = undefined;
    probing = false;
    probeSettled = false;
  }

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet dialogBody()}
  <p class="project-context" data-testid="new-session-project-context">
    <span class="project-context-name">{project.name}</span>
    <span class="project-context-path font-mono">{project.path}</span>
  </p>

  <form class="session-form" onsubmit={handleSubmit}>
    <Field label="Agent" grouped>
      <Select
        value={selectedProvider}
        options={PROVIDER_OPTIONS}
        onChange={(id) => (selectedProvider = id)}
        label="Agent"
        dataTestId="new-session-provider"
      />
    </Field>

    {#if resolvingWorkspace}
      <Field label="Workspace" grouped>
        <p class="status-line" data-testid="new-session-workspace-probing">
          <WovenLoader size="sm" label="Checking whether the project folder is a git repository" />
          Checking the project folder…
        </p>
      </Field>
    {:else if effectiveIsGitRepo === true}
      <Field label="Workspace" grouped>
        {#snippet children({ labelId })}
          <RadioGroup
            value={workspaceChoice}
            options={WORKSPACE_OPTIONS}
            onChange={(v) => (workspaceChoice = v as WorkspaceChoice)}
            labelledBy={labelId}
            dataTestId="new-session-workspace"
          />
        {/snippet}
      </Field>
    {/if}

    <Field label="Title (optional)">
      {#snippet children({ id, describedBy, errorId, invalid, required })}
        <Input
          {id}
          {describedBy}
          {errorId}
          {invalid}
          {required}
          bind:value={title}
          placeholder="Defaults to the project folder"
          dataTestId="new-session-title"
        />
      {/snippet}
    </Field>

    <Field label="Starting prompt">
      {#snippet children({ id, describedBy, errorId, invalid, required })}
        <TextArea
          {id}
          {describedBy}
          {errorId}
          {invalid}
          {required}
          bind:value={prompt}
          placeholder="What should the agent do first?"
          dataTestId="new-session-prompt"
        />
      {/snippet}
    </Field>

    {#if createError}
      <ErrorNotice message={createError} />
    {/if}

    <FormActions>
      <Button variant="secondary" onclick={handleClose}>Cancel</Button>
      <Button
        type="submit"
        variant="primary"
        disabled={!canSubmit}
        loading={creating}
        dataTestId="new-session-submit"
      >
        Create session
      </Button>
    </FormActions>
  </form>
{/snippet}

<Dialog {open} label="New session" onClose={handleClose} size="md" children={dialogBody}>
  {#snippet header()}
    <h2>New session</h2>
  {/snippet}
</Dialog>

<style>
  .status-line {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .project-context {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2xs) var(--space-sm);
    margin: 0;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-fill-subtle);
    font-size: var(--text-small-size);
  }

  .project-context-name {
    font-weight: 500;
    color: var(--color-text-primary);
  }

  .project-context-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }

  .session-form {
    display: flex;
    flex-direction: column;
    /* Comfortably above `Field`'s own internal label-to-control gap, so each
       label reads as belonging to the box beneath it rather than floating
       between two of them. See `ui/Field.svelte`'s note on that contract. */
    gap: var(--space-md);
  }
</style>
