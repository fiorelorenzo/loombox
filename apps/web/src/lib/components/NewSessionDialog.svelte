<script lang="ts">
  /**
   * The "New session" flow (SPEC §7.1; issue #385): pick a target/node
   * (`TargetPicker`, backed by `RelayClient.listTargets()`), a provider
   * (fixed to `'claude'` for now — the locked v1 decision, `docs/`'s
   * "Claude-only" architectural call — but shown as a real, extensible
   * picker rather than hidden), a project folder, and a starting prompt,
   * then creates the session via `RelayClient.createSession` and hands the
   * new session id back so the caller can open it.
   *
   * `client` is typed to the narrow `NewSessionClient` interface (not the
   * full `RelayClient`) so a hermetic component test can inject a fake
   * without spinning up a real relay — mirrors `InteractiveTerminal.svelte`'s
   * own narrowed-client pattern elsewhere in this package. `undefined`
   * (not yet connected) renders the dialog closed for content but still
   * mounts, matching `open`'s own gate — `+page.svelte` only ever passes a
   * defined `client` once `status === 'open'` in practice.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §4,
   * issue #431): the hand-rolled backdrop+card chrome moves onto the
   * shared `Dialog` primitive (`thread-lift` entrance, Esc/backdrop-click/
   * focus-trap). The no-targets empty state and the error line now read
   * through `EmptyState`/`ErrorNotice`'s visual language; the outer
   * elements keep their original `data-testid`s (`EmptyState`/
   * `ErrorNotice` hardcode their own for their own component tests, so
   * this file wraps rather than relies on those) so this component's own
   * tests are unaffected.
   *
   * Deck migration (redesign v2 §2 "One button language", issue #464):
   * every hand-rolled `.btn*` gives way to the shared `Button` primitive
   * (using its `dataTestId` override so `new-session-submit`/
   * `new-session-add-target-cta` keep their exact selectors), and the two
   * inline error lines (`targetsError`/`createError`) now read through
   * `ErrorNotice` instead of a hand-styled `<p class="error">`.
   */
  import type { CreateSessionOptions, TargetListEntry } from '$lib/relay-client';
  import TargetPicker from './TargetPicker.svelte';
  import WovenLoader from './WovenLoader.svelte';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';

  export interface NewSessionClient {
    listTargets: (timeoutMs?: number) => Promise<TargetListEntry[]>;
    createSession: (options: CreateSessionOptions) => Promise<string>;
  }

  interface Props {
    open: boolean;
    client: NewSessionClient | undefined;
    onCreated: (sessionId: string) => void;
    onClose: () => void;
    /** Opens the "Add target" wizard (issue #408) from the no-targets empty state below; omitted, that CTA simply doesn't render. */
    onAddTarget?: () => void;
  }

  const { open, client, onCreated, onClose, onAddTarget }: Props = $props();

  let targets = $state<TargetListEntry[]>([]);
  let targetsLoading = $state(false);
  let targetsError = $state<string | undefined>(undefined);
  let selectedTargetId = $state<string | undefined>(undefined);
  let selectedProvider = $state('claude');
  let projectPath = $state('');
  let title = $state('');
  let prompt = $state('');
  let creating = $state(false);
  let createError = $state<string | undefined>(undefined);

  // Re-fetches (and resets the form) every time the dialog actually opens,
  // or once `client` becomes available while it's already open (the very
  // first render, before the connection has finished opening) — never on
  // every re-render, since both `open`/`client` are this effect's only
  // reactive reads.
  $effect(() => {
    if (!open) return;
    resetForm();
    if (client) void loadTargets();
  });

  async function loadTargets(): Promise<void> {
    if (!client) return;
    targetsLoading = true;
    targetsError = undefined;
    try {
      targets = await client.listTargets();
      const firstReachable = targets.find((target) => target.reachable);
      selectedTargetId = firstReachable?.targetId ?? targets[0]?.targetId;
    } catch (error) {
      targetsError = error instanceof Error ? error.message : String(error);
    } finally {
      targetsLoading = false;
    }
  }

  const canSubmit = $derived(
    !creating &&
      client !== undefined &&
      selectedTargetId !== undefined &&
      projectPath.trim() !== '' &&
      prompt.trim() !== '',
  );

  async function handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (!client || !selectedTargetId || !canSubmit) return;
    creating = true;
    createError = undefined;
    try {
      const sessionId = await client.createSession({
        targetId: selectedTargetId,
        provider: selectedProvider,
        projectPath: projectPath.trim(),
        title: title.trim() || undefined,
        prompt: prompt.trim(),
      });
      onCreated(sessionId);
      onClose();
    } catch (error) {
      createError = error instanceof Error ? error.message : String(error);
    } finally {
      creating = false;
    }
  }

  function resetForm(): void {
    targets = [];
    targetsError = undefined;
    selectedTargetId = undefined;
    projectPath = '';
    title = '';
    prompt = '';
    createError = undefined;
  }

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet addTargetCta()}
  <Button variant="primary" size="sm" onclick={onAddTarget} dataTestId="new-session-add-target-cta">
    Add a target
  </Button>
{/snippet}

{#snippet dialogBody()}
  {#if targetsLoading}
    <p class="status-line">
      <WovenLoader label="Looking for connected nodes" />
      Looking for connected nodes…
    </p>
  {:else if targetsError}
    <ErrorNotice message={targetsError} />
  {:else if targets.length === 0}
    <div class="empty-state-slot" data-testid="new-session-no-targets">
      <EmptyState
        message="No nodes connected yet — start a loombox node pointed at this relay."
        cta={onAddTarget ? addTargetCta : undefined}
      />
    </div>
  {:else}
    <TargetPicker {targets} value={selectedTargetId} onChange={(id) => (selectedTargetId = id)} />
  {/if}

  <form class="session-form" onsubmit={handleSubmit}>
    <label for="new-session-provider">Provider</label>
    <select
      id="new-session-provider"
      bind:value={selectedProvider}
      data-testid="new-session-provider"
    >
      <option value="claude">Claude Code</option>
    </select>

    <label for="new-session-project-path">Project folder</label>
    <input
      id="new-session-project-path"
      type="text"
      placeholder="/home/you/project"
      bind:value={projectPath}
      data-testid="new-session-project-path"
    />

    <label for="new-session-title">Title (optional)</label>
    <input
      id="new-session-title"
      type="text"
      placeholder="Defaults to the project folder"
      bind:value={title}
      data-testid="new-session-title"
    />

    <label for="new-session-prompt">Starting prompt</label>
    <textarea
      id="new-session-prompt"
      rows="3"
      placeholder="What should the agent do first?"
      bind:value={prompt}
      data-testid="new-session-prompt"></textarea>

    {#if createError}
      <ErrorNotice message={createError} />
    {/if}

    <div class="actions">
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
    </div>
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

  .empty-state-slot {
    border-radius: var(--radius-lg);
    background: var(--color-fill-subtle);
  }

  .session-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .session-form label {
    margin-top: var(--space-xs);
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .session-form input,
  .session-form select,
  .session-form textarea {
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: inherit;
    font-family: inherit;
    font-size: var(--text-body-size);
    resize: vertical;
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .session-form input:focus-visible,
  .session-form select:focus-visible,
  .session-form textarea:focus-visible {
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
