<script lang="ts">
  /**
   * Per-project agent instructions (SPEC §7.18; issue #260): view and edit
   * a project's own `AGENTS.md`/`CLAUDE.md` directly from the cockpit,
   * rather than only on disk. Sits in `ProjectConfigPanel`'s Config tab
   * beside `TestRunnerConfigPanel`/`PermissionPolicyPanel` — same
   * "genuinely lives on the owning node, needs a live session, not
   * `localStorage`" shape those two document, except here the node reads
   * and writes a REAL file in the session's worktree
   * (`@loombox/node`'s `agent-instructions.ts`) rather than a store record.
   *
   * Both files are always offered as tabs, whether or not they exist yet
   * (issue #260's "if neither file exists, offer to create one" — this
   * panel never shows a blank/broken state: a file that doesn't exist yet
   * opens as an empty, clearly-labeled create draft, defaulting to
   * `AGENTS.md`, the more universal cross-tool convention). Switching tabs
   * discards an unsaved draft on the tab being left — this is a single
   * free-text editor, not a form with per-field autosave, and adding an
   * "unsaved changes" guard is out of this issue's scope.
   *
   * The write is optimistic-concurrency, never last-write-wins: every
   * loaded file carries a `hash` (`RelayClient.getAgentInstructions`'s own
   * per-file token), sent back as `baseHash` on save. A save that lands
   * after the file changed underneath (another device, an agent, a human
   * editing on disk) comes back as `outcome: 'conflict'` — this panel
   * NEVER retries with the new hash on its own; it shows the user what's
   * actually on disk now and requires an explicit "Reload latest version"
   * click before anything is saved again, so a stale edit can never
   * silently clobber someone else's change.
   */
  import type {
    AgentInstructionsFileNameV1,
    AgentInstructionsFileStateV1,
    AgentInstructionsGetResponsePayloadV1,
    AgentInstructionsSetRequestPayloadV1,
    AgentInstructionsSetResponsePayloadV1,
  } from '@loombox/protocol';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import Field from './ui/Field.svelte';
  import TextArea from './ui/TextArea.svelte';
  import WovenLoader from './WovenLoader.svelte';

  /** The two calls this panel needs off `RelayClient` — see the file doc comment's DI note. */
  export interface AgentInstructionsClient {
    getAgentInstructions(sessionId: string): Promise<AgentInstructionsGetResponsePayloadV1>;
    setAgentInstructions(
      sessionId: string,
      params: AgentInstructionsSetRequestPayloadV1,
    ): Promise<AgentInstructionsSetResponsePayloadV1>;
  }

  const FILE_NAMES: readonly AgentInstructionsFileNameV1[] = ['AGENTS.md', 'CLAUDE.md'];

  interface Props {
    projectPath: string;
    sessionId?: string;
    client?: AgentInstructionsClient;
  }

  const { sessionId, client }: Props = $props();

  let files = $state<AgentInstructionsFileStateV1[]>([]);
  let selected = $state<AgentInstructionsFileNameV1>('AGENTS.md');
  let draft = $state('');
  /** The hash `draft` was loaded from, or `null` while `selected` doesn't exist yet (a create draft) — sent back as `setAgentInstructions`'s own `baseHash`. */
  let baseHash = $state<string | null>(null);
  let loading = $state(false);
  let loadError = $state<string | undefined>(undefined);
  let saving = $state(false);
  let saveError = $state<string | undefined>(undefined);
  /** `undefined`: no conflict. `null`: the file was deleted underneath the last save attempt. Otherwise the file's real current on-disk state — set only by a `'conflict'` `setAgentInstructions` outcome, cleared by {@link reloadLatest} or by switching files. */
  let conflict = $state<AgentInstructionsFileStateV1 | null | undefined>(undefined);

  const existsById = $derived(new Map(files.map((file) => [file.fileName, file])));
  const creating = $derived(baseHash === null);
  const saveDisabled = $derived(saving || (creating && draft.trim().length === 0));

  function pickDefaultFileName(
    loaded: AgentInstructionsFileStateV1[],
  ): AgentInstructionsFileNameV1 {
    return loaded.some((file) => file.fileName === 'AGENTS.md')
      ? 'AGENTS.md'
      : loaded.some((file) => file.fileName === 'CLAUDE.md')
        ? 'CLAUDE.md'
        : 'AGENTS.md';
  }

  /** Sets `draft`/`baseHash` from `files`'s current entry for `fileName`, or an empty create draft when it has none — never touches `files` itself. */
  function applySelection(fileName: AgentInstructionsFileNameV1): void {
    selected = fileName;
    const existing = existsById.get(fileName);
    draft = existing?.content ?? '';
    baseHash = existing?.hash ?? null;
    conflict = undefined;
    saveError = undefined;
  }

  async function loadFiles(
    currentSessionId: string,
    currentClient: AgentInstructionsClient,
  ): Promise<void> {
    loading = true;
    loadError = undefined;
    try {
      const result = await currentClient.getAgentInstructions(currentSessionId);
      if (result.outcome === 'error') {
        loadError = result.message;
        files = [];
        return;
      }
      files = result.files;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      files = [];
    } finally {
      loading = false;
    }
  }

  // Reloads whenever the selected session (or, in a test, the injected
  // client) changes — `ProjectConfigPanel`'s "config" tab stays mounted
  // across a session switch, so this effect, not a one-shot `onMount`,
  // keeps the shown files in sync with whichever project is actually
  // selected (mirrors `TestRunnerConfigPanel`'s identical effect).
  $effect(() => {
    if (!sessionId || !client) {
      files = [];
      applySelection('AGENTS.md');
      return;
    }
    void loadFiles(sessionId, client).then(() => applySelection(pickDefaultFileName(files)));
  });

  function selectTab(fileName: AgentInstructionsFileNameV1): void {
    if (fileName === selected) return;
    applySelection(fileName);
  }

  async function handleSave(): Promise<void> {
    if (!sessionId || !client) return;
    saving = true;
    saveError = undefined;
    conflict = undefined;
    try {
      const response = await client.setAgentInstructions(sessionId, {
        fileName: selected,
        content: draft,
        baseHash,
      });
      if (response.outcome === 'ok') {
        files = [
          ...files.filter((file) => file.fileName !== response.fileName),
          { fileName: response.fileName, content: response.content, hash: response.hash },
        ];
        baseHash = response.hash;
      } else if (response.outcome === 'conflict') {
        conflict = response.current;
      } else {
        saveError = response.message;
      }
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  /** Discards the stale draft and reloads `selected` from what's actually on disk now — the only way past a `'conflict'`, per the file doc comment's "never silently clobber" contract. */
  async function reloadLatest(): Promise<void> {
    if (!sessionId || !client) return;
    await loadFiles(sessionId, client);
    applySelection(selected);
  }
</script>

<div class="agent-instructions" data-testid="agent-instructions-panel">
  {#if !sessionId}
    <EmptyState message="Select a session to view and edit this project's agent instructions." />
  {:else}
    <Card elevation="raised" padding="md" class="agent-instructions-card">
      <div class="tabs" role="tablist" aria-label="Instructions file">
        {#each FILE_NAMES as fileName (fileName)}
          <Button
            variant={selected === fileName ? 'primary' : 'secondary'}
            size="sm"
            role="tab"
            aria-selected={selected === fileName}
            onclick={() => selectTab(fileName)}
            dataTestId={`agent-instructions-tab-${fileName}`}
          >
            {fileName}{existsById.has(fileName) ? '' : ' (not created)'}
          </Button>
        {/each}
      </div>

      {#if loadError}
        <ErrorNotice
          message={`Could not load agent instructions: ${loadError}`}
          retryable
          onRetry={() => void (sessionId && client && loadFiles(sessionId, client))}
        />
      {/if}

      {#if loading}
        <p class="loading" data-testid="agent-instructions-loading">
          <WovenLoader size="sm" label="Loading" />
          Loading {selected}…
        </p>
      {:else}
        {#if creating}
          <p class="hint" data-testid="agent-instructions-create-hint">
            {selected} doesn't exist yet — start typing and save to create it.
          </p>
        {/if}

        {#if conflict !== undefined}
          <ErrorNotice
            message={conflict === null
              ? `${selected} was deleted on disk since you started editing — your draft below was NOT saved.`
              : `${selected} changed on disk since you started editing — your draft below was NOT saved.`}
          />
          <Button
            variant="secondary"
            size="sm"
            onclick={() => void reloadLatest()}
            dataTestId="agent-instructions-reload"
          >
            Reload latest version
          </Button>
        {/if}

        {#if saveError}
          <ErrorNotice message={`Could not save ${selected}: ${saveError}`} />
        {/if}

        <Field label={selected}>
          {#snippet children({ id, describedBy, errorId, invalid })}
            <TextArea
              {id}
              {describedBy}
              {errorId}
              {invalid}
              bind:value={draft}
              monospace
              rows={12}
              dataTestId="agent-instructions-editor"
            />
          {/snippet}
        </Field>

        <Button
          size="sm"
          loading={saving}
          disabled={saveDisabled}
          onclick={() => void handleSave()}
          dataTestId="agent-instructions-save"
        >
          {creating ? `Create ${selected}` : 'Save'}
        </Button>
      {/if}
    </Card>
  {/if}
</div>

<style>
  .agent-instructions {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .agent-instructions :global(.agent-instructions-card) {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .tabs {
    display: flex;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .hint {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
  }

  .loading {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }
</style>
