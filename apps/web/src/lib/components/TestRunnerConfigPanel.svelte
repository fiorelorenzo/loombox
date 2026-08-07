<script lang="ts">
  /**
   * A project's test/lint/build command config surface (SPEC §7.15; issue
   * #245): view/set/override each command explicitly, and ask the owning
   * node to auto-detect sensible defaults from `package.json` — shown as a
   * suggestion the user must explicitly accept, never silently applied
   * (issue #245's own acceptance line). Unlike its `ProjectConfigPanel`
   * siblings (`McpServerConfigPanel`/`PluginConfigPanel`/
   * `TrackerConfigPanel`, all pure `localStorage`), this config genuinely
   * lives on the owning node (`TestRunnerConfigStore`, `@loombox/node`) —
   * it is the node that spawns the configured command, on whichever target
   * (`local` or `ssh:`) the session runs on, so the node is what owns the
   * config that decides what to spawn. `client` is narrowed to just the
   * three calls this panel needs (mirrors the `storage`-prop DI pattern
   * every sibling panel already uses), satisfied structurally by the real
   * `RelayClient` with no adapter needed.
   *
   * Requires an active session (`sessionId`) to route a request to its
   * owning node — `ProjectConfigPanel`'s own mount gate already guarantees
   * one exists whenever this panel is visible (`selectedProjectPath` is
   * derived FROM `selectedSessionId`), but `sessionId` stays optional here
   * so this panel degrades to an explanatory empty state instead of
   * crashing on the one render frame before that's true.
   */
  import type { TestRunnerCommandsV1 } from '@loombox/protocol';
  import AsyncPanel from './ui/AsyncPanel.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import Field from './ui/Field.svelte';
  import Input from './ui/Input.svelte';
  import { loadErrorMessage, type AsyncPanelState } from '$lib/async-panel';

  /** The three calls this panel needs off `RelayClient` — see the file doc comment's DI note. */
  export interface TestRunnerConfigClient {
    getTestRunnerConfig(sessionId: string): Promise<TestRunnerCommandsV1>;
    setTestRunnerConfig(
      sessionId: string,
      commands: TestRunnerCommandsV1,
    ): Promise<TestRunnerCommandsV1>;
    detectTestRunnerConfig(sessionId: string): Promise<TestRunnerCommandsV1>;
  }

  type CommandKey = 'test' | 'lint' | 'build';

  const COMMAND_FIELDS: ReadonlyArray<{ key: CommandKey; label: string }> = [
    { key: 'test', label: 'Test command' },
    { key: 'lint', label: 'Lint command' },
    { key: 'build', label: 'Build command' },
  ];

  interface Props {
    projectPath: string;
    sessionId?: string;
    client?: TestRunnerConfigClient;
  }

  const { sessionId, client }: Props = $props();

  let saved = $state<TestRunnerCommandsV1>({});
  let drafts = $state<Record<CommandKey, string>>({ test: '', lint: '', build: '' });
  let loading = $state(false);
  let loadError = $state<string | undefined>(undefined);
  let savingKey = $state<CommandKey | undefined>(undefined);
  let saveError = $state<string | undefined>(undefined);
  let detecting = $state(false);
  let detectError = $state<string | undefined>(undefined);
  let suggestions = $state<TestRunnerCommandsV1>({});

  function syncDraftsFromSaved(): void {
    drafts = { test: saved.test ?? '', lint: saved.lint ?? '', build: saved.build ?? '' };
  }

  async function load(
    currentSessionId: string,
    currentClient: TestRunnerConfigClient,
  ): Promise<void> {
    loading = true;
    loadError = undefined;
    try {
      saved = await currentClient.getTestRunnerConfig(currentSessionId);
      syncDraftsFromSaved();
    } catch (err) {
      loadError = loadErrorMessage('The runner config', err);
    } finally {
      loading = false;
    }
  }

  /** One tagged value, not two independent flags — issue #650. */
  const savedState = $derived<AsyncPanelState<TestRunnerCommandsV1>>(
    loading
      ? { status: 'loading' }
      : loadError
        ? { status: 'error', message: loadError, retryable: true }
        : { status: 'loaded', data: saved },
  );

  // Reloads whenever the selected session (or, in a test, the injected
  // client) changes — `ProjectConfigPanel`'s "config" tab stays mounted
  // across a session switch (issue #571's own acceptance line), so this
  // effect, not a one-shot `onMount`, is what keeps the shown commands in
  // sync with whichever project is actually selected.
  $effect(() => {
    if (!sessionId || !client) {
      saved = {};
      drafts = { test: '', lint: '', build: '' };
      suggestions = {};
      return;
    }
    void load(sessionId, client);
  });

  async function saveField(key: CommandKey, value: string): Promise<void> {
    if (!sessionId || !client) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    savingKey = key;
    saveError = undefined;
    try {
      saved = await client.setTestRunnerConfig(sessionId, { [key]: trimmed });
      syncDraftsFromSaved();
      suggestions = { ...suggestions, [key]: undefined };
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      savingKey = undefined;
    }
  }

  function handleFieldSubmit(key: CommandKey, event: SubmitEvent): void {
    event.preventDefault();
    void saveField(key, drafts[key]);
  }

  async function handleDetect(): Promise<void> {
    if (!sessionId || !client) return;
    detecting = true;
    detectError = undefined;
    try {
      suggestions = await client.detectTestRunnerConfig(sessionId);
    } catch (err) {
      detectError = err instanceof Error ? err.message : String(err);
    } finally {
      detecting = false;
    }
  }

  /** Fills the draft field from the shown suggestion and saves it in the same click — the suggestion was already visibly displayed first, so this click itself IS the required confirmation (issue #245's "shown for confirmation before being saved, not silently applied"). */
  async function acceptSuggestion(key: CommandKey): Promise<void> {
    const value = suggestions[key];
    if (!value) return;
    drafts = { ...drafts, [key]: value };
    await saveField(key, value);
  }
</script>

<div class="test-runner-config" data-testid="test-runner-config-panel">
  {#if !sessionId}
    <EmptyState message="Select a session to configure this project's test/lint/build commands." />
  {:else}
    <Card elevation="raised" padding="md" class="config-section">
      <section class="commands">
        {#if saveError}
          <ErrorNotice message={`Could not save: ${saveError}`} />
        {/if}
        <AsyncPanel
          state={savedState}
          loadingLabel="Loading"
          loadingTestId="test-runner-config-loading"
          loadingText="Loading saved commands…"
          onRetry={() => void (sessionId && client && load(sessionId, client))}
        >
          {#snippet content()}
            {#each COMMAND_FIELDS as field (field.key)}
              <form class="command-form" onsubmit={(event) => handleFieldSubmit(field.key, event)}>
                <Field label={field.label}>
                  {#snippet children({ id, describedBy, errorId, invalid, required })}
                    <div class="command-row">
                      <Input
                        {id}
                        {describedBy}
                        {errorId}
                        {invalid}
                        {required}
                        monospace
                        placeholder="e.g. pnpm test"
                        bind:value={drafts[field.key]}
                        dataTestId={`test-runner-${field.key}-input`}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        loading={savingKey === field.key}
                        disabled={drafts[field.key].trim().length === 0}
                        dataTestId={`test-runner-${field.key}-save`}
                      >
                        Save
                      </Button>
                    </div>
                  {/snippet}
                </Field>
                {#if suggestions[field.key]}
                  <p class="suggestion" data-testid={`test-runner-${field.key}-suggestion`}>
                    Detected: <code>{suggestions[field.key]}</code>
                    <Button
                      variant="secondary"
                      size="sm"
                      onclick={() => void acceptSuggestion(field.key)}
                      dataTestId={`test-runner-${field.key}-accept`}
                    >
                      Accept
                    </Button>
                  </p>
                {/if}
              </form>
            {/each}
          {/snippet}
        </AsyncPanel>

        {#if detectError}
          <ErrorNotice message={`Could not auto-detect commands: ${detectError}`} />
        {/if}
        <Button
          variant="secondary"
          size="sm"
          loading={detecting}
          onclick={() => void handleDetect()}
          dataTestId="test-runner-detect"
        >
          Auto-detect from package.json
        </Button>
      </section>
    </Card>
  {/if}
</div>

<style>
  .test-runner-config {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .commands {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .command-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .command-row {
    display: flex;
    gap: var(--space-xs);
    align-items: flex-start;
  }

  .command-row :global(.ui-input) {
    flex: 1 1 auto;
    min-width: 0;
  }

  .suggestion {
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    flex-wrap: wrap;
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
  }

  .suggestion code {
    font-family: var(--font-mono);
    color: var(--color-text-primary);
  }
</style>
