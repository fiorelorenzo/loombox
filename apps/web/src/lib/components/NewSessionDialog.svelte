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
   */
  import type { CreateSessionOptions, TargetListEntry } from '$lib/relay-client';
  import TargetPicker from './TargetPicker.svelte';
  import WovenLoader from './WovenLoader.svelte';

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

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="dialog-backdrop"
    role="presentation"
    onclick={handleClose}
    data-testid="new-session-backdrop"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="dialog"
      role="dialog"
      aria-label="New session"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      data-testid="new-session-dialog"
    >
      <h2>New session</h2>

      {#if targetsLoading}
        <p class="status-line">
          <WovenLoader label="Looking for connected nodes" />
          Looking for connected nodes…
        </p>
      {:else if targetsError}
        <p class="error" role="alert">{targetsError}</p>
      {:else if targets.length === 0}
        <div class="empty-state" data-testid="new-session-no-targets">
          <p>No nodes connected yet — start a loombox node pointed at this relay.</p>
          {#if onAddTarget}
            <button
              type="button"
              class="add-target-cta"
              onclick={onAddTarget}
              data-testid="new-session-add-target-cta"
            >
              Add a target
            </button>
          {/if}
        </div>
      {:else}
        <TargetPicker
          {targets}
          value={selectedTargetId}
          onChange={(id) => (selectedTargetId = id)}
        />
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
          <p class="error" role="alert">{createError}</p>
        {/if}

        <div class="actions">
          <button type="button" class="cancel" onclick={handleClose}>Cancel</button>
          <button type="submit" disabled={!canSubmit} data-testid="new-session-submit">
            {#if creating}
              <WovenLoader label="Creating session" />
              Creating…
            {:else}
              Create session
            {/if}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: var(--color-overlay);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 6vh var(--space-md);
    overflow-y: auto;
    z-index: var(--z-modal);
  }

  .dialog {
    width: min(28rem, 100%);
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    padding: var(--space-lg);
    border-radius: var(--radius-xl);
    background: var(--color-surface-raised);
    color: var(--color-text-primary);
    box-shadow: var(--shadow-lg);
  }

  .dialog h2 {
    margin: 0;
  }

  .status-line {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
    opacity: 0.7;
    font-size: var(--text-small-size);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-sm);
    padding: var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-fill-subtle);
    font-size: var(--text-small-size);
  }

  .empty-state p {
    margin: 0;
  }

  .add-target-cta {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  .session-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .session-form label {
    margin-top: var(--space-xs);
    font-size: var(--text-small-size);
    opacity: 0.8;
  }

  .session-form input,
  .session-form select,
  .session-form textarea {
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-fill-subtle);
    color: inherit;
    font-family: inherit;
    font-size: 0.9rem;
    resize: vertical;
  }

  .session-form input:focus-visible,
  .session-form select:focus-visible,
  .session-form textarea:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
    margin-top: var(--space-sm);
  }

  .actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-xs);
    border-radius: var(--radius-md);
    padding: var(--space-sm) var(--space-lg);
    cursor: pointer;
    font-weight: 600;
  }

  .actions button:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .actions .cancel {
    border: 1px solid var(--color-border);
    background: transparent;
    color: inherit;
  }

  .actions button[type='submit'] {
    border: none;
    background: var(--color-accent);
    color: var(--color-accent-contrast);
  }

  .actions button[type='submit']:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-small-size);
  }
</style>
