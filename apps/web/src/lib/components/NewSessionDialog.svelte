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
   * all: only a confirmed `true` shows it. `AddProjectDialog` resolves it
   * once, when the project is registered (`DirectoryPicker`'s own
   * `gitRepo` flag), so it is already a settled fact by the time this
   * dialog can ever open (forms + real providers design spec §1/§3,
   * defect #2) — no probe, no loading state, and no reflow while the user
   * is mid-keystroke, unlike the `browseDirectory` round trip this file
   * used to fire on every open. A project this device has only ever
   * adopted from a session and never actually browsed to simply has no
   * worktree choice to offer, exactly like a confirmed non-repo; per
   * `CreateSessionOptions.worktree`'s own doc comment that just leaves the
   * node's per-target default in charge rather than guessing here.
   *
   * Agent availability is real now too (forms + real providers design spec
   * §2/§3, defect #1): `providers` is `TargetListEntry.providers` for
   * `project`'s own target — the relay's verbatim forward of the node's own
   * PATH probe for each registered `AcpProviderModule.requiredCommand` —
   * never a hardcoded guess. Two or more renders an actual `Select`;
   * exactly one is shown as a fact in the context line instead of a
   * dropdown with nothing to choose (the ticket's most visible defect: a
   * one-option `<select>` as the form's first, most prominent field); zero
   * disables submission with a message naming the target rather than
   * silently offering an agent that would fail at spawn.
   *
   * Field order (design spec §3, defects #3/#4): the starting prompt is the
   * only thing the user must actually supply, so it now leads and is the
   * largest control on the form; Title trails last, and its "defaults to
   * the project folder" copy moved out of the placeholder (which vanishes
   * on the first keystroke) into `Field`'s own persistent `help` slot.
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
  import { PROVIDER_LABELS } from '$lib/providers';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import FormActions from './ui/FormActions.svelte';
  import Input from './ui/Input.svelte';
  import RadioGroup, { type RadioOption } from './ui/RadioGroup.svelte';
  import Select, { type SelectOption } from './ui/Select.svelte';
  import TextArea from './ui/TextArea.svelte';

  export interface NewSessionClient {
    createSession: (options: CreateSessionOptions) => Promise<string>;
  }

  interface Props {
    open: boolean;
    project: Project;
    client: NewSessionClient | undefined;
    /**
     * The provider ids `project`'s own target can actually spawn right now
     * (`TargetListEntry.providers`, forwarded verbatim from the node's own
     * probe of each registered `AcpProviderModule.requiredCommand` against
     * that target's PATH — design spec §2). An empty array is a real,
     * meaningful answer ("reachable, nothing installed"), not "still
     * loading": the caller only ever renders this dialog once its own
     * target list has resolved at least once.
     */
    providers: string[];
    /** `project`'s own target, named for a human where possible — used only to name it in the zero-providers message below. Mirrors `+page.svelte`'s own `sessionTargetLabel` label-with-id-fallback idiom. */
    targetLabel: string;
    onClose: () => void;
    onCreated: (sessionId: string) => void;
  }

  const { open, project, client, providers, targetLabel, onClose, onCreated }: Props = $props();

  const providerOptions: SelectOption[] = $derived(
    providers.map((id) => ({ id, label: PROVIDER_LABELS[id]?.name ?? id })),
  );
  let selectedProvider = $state('');
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

  /**
   * Tracks the previous `open` so the reset below fires on the closed -> open
   * TRANSITION only. A plain `let`, deliberately not `$state`: it is bookkeeping
   * for the effect, and making it reactive would feed the effect its own writes.
   */
  let wasOpen = false;

  // Resets the per-session fields when the dialog actually opens - the
  // transition, not merely "this effect ran while `open` was true". That
  // distinction is the whole fix, and it was measured rather than reasoned:
  //
  // `resetForm()` reads `providers` (for the default `selectedProvider`), and a
  // Svelte 5 `$effect` tracks reads made inside the functions it calls, so this
  // effect used to depend on `providers` too. That prop's identity churns
  // constantly in production - `+page.svelte` derives it from issue #269's
  // polled target list - so the reset re-ran on ordinary re-renders. Driving the
  // built app against the deployed relay, a prompt typed into the open dialog
  // was wiped within one second, repeatedly, which made the field unusable.
  //
  // Gating on the transition fixes that at the root, and covers the sibling case
  // an `untrack` around `resetForm` would miss: `open` being re-assigned the
  // same `true` (any parent handing down a fresh props object, and
  // `@testing-library/svelte`'s `rerender`) re-runs the effect just the same.
  // One guard, both causes; an operator's half-typed sentence now survives
  // everything except genuinely reopening the dialog.
  $effect(() => {
    const isOpen = open;
    if (isOpen && !wasOpen) resetForm();
    wasOpen = isOpen;
  });

  const canSubmit = $derived(
    !creating && client !== undefined && providers.length > 0 && prompt.trim() !== '',
  );

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
        // when the folder isn't a repo, there is no genuine per-session
        // choice to send (see the file doc comment).
        ...(project.isGitRepo === true ? { worktree: workspaceChoice === 'worktree' } : {}),
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
    selectedProvider = providers[0] ?? '';
    workspaceChoice = 'worktree';
    title = '';
    prompt = '';
    creating = false;
    createError = undefined;
  }

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet dialogBody()}
  <p class="project-context" data-testid="new-session-project-context">
    <span class="project-context-name">{project.name}</span>
    <span class="project-context-path font-mono">{project.path}</span>
    {#if providers.length === 1}
      <span class="project-context-agent" data-testid="new-session-agent-fact">
        {PROVIDER_LABELS[providers[0]]?.name ?? providers[0]}
      </span>
    {/if}
  </p>

  <form class="session-form" onsubmit={handleSubmit}>
    <Field label="Starting prompt" required>
      {#snippet children({ id, describedBy, errorId, invalid, required })}
        <TextArea
          {id}
          {describedBy}
          {errorId}
          {invalid}
          {required}
          bind:value={prompt}
          rows={6}
          placeholder="What should the agent do first?"
          dataTestId="new-session-prompt"
        />
      {/snippet}
    </Field>

    {#if providers.length >= 2}
      <Field label="Agent" grouped>
        <Select
          value={selectedProvider}
          options={providerOptions}
          onChange={(id) => (selectedProvider = id)}
          label="Agent"
          dataTestId="new-session-provider"
        />
      </Field>
    {:else if providers.length === 0}
      <ErrorNotice
        message={`No agent CLI was found on ${targetLabel}. Install claude, codex, or omp there and try again.`}
      />
    {/if}

    {#if project.isGitRepo === true}
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

    <Field label="Title" help="Defaults to the project folder">
      {#snippet children({ id, describedBy, errorId, invalid, required })}
        <Input
          {id}
          {describedBy}
          {errorId}
          {invalid}
          {required}
          bind:value={title}
          dataTestId="new-session-title"
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
  /* Context, not a field (forms + real providers design spec §3/§5,
     defect #9): no control fill, no input radius — just a quiet hairline
     under the summary so it still reads as one block, distinct from the
     real controls below it. */
  .project-context {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2xs) var(--space-sm);
    margin: 0;
    padding-bottom: var(--space-sm);
    border-bottom: 1px solid var(--color-border-subtle);
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

  .project-context-agent {
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
