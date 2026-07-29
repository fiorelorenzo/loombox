<script lang="ts">
  /**
   * A project's plugin/extension config surface (SPEC.md §7.7; issue #191):
   * view, add, and remove a project's enabled plugin/extension list,
   * entirely independently of `McpServerConfigPanel`'s MCP-server list —
   * this component reads/writes only `plugin-store.ts`'s own storage key,
   * never touching `mcp-server-store.ts`. See
   * `@loombox/providers-core`'s `plugin-config.ts` module doc for what
   * "plugin" concretely means (or, for Claude Code/Codex today, doesn't
   * yet mean anything beyond MCP servers) — this is a forward-looking
   * config surface, not a claim that adding an entry here changes what an
   * agent session actually loads.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §3/§4/§6,
   * issue #435): the two sections (plugins list, add form) each sit on a
   * `Card elevation="raised"`, the list becomes quiet hairline-divided rows
   * with a tactile toggle switch, and an empty list reads through
   * `EmptyState`.
   *
   * Deck migration (redesign v2 design spec §2, issue #471): the remove and
   * add-submit buttons now route through the shared `Button` primitive,
   * using its `dataTestId` override (issue #479, which landed after #435's
   * hand-styled-instead-of-imported tradeoff note above was written) to
   * keep this surface's exact per-plugin ids (`plugin-remove-${name}`,
   * `plugin-add-submit`) — the earlier workaround is no longer needed here.
   * The duplicate-add/error text now renders through the real `ErrorNotice`
   * primitive; the test that used to key off its fixed `plugin-config-error`
   * testid now asserts on the visible message text instead (mirrors
   * `TargetStatusView.test.ts`'s pattern), since `ErrorNotice`'s own root
   * testid has no override. Every other `data-testid` is unchanged; only
   * markup/CSS move.
   */
  import { PluginConfigError, type PluginConfig } from '@loombox/providers-core/browser';
  import {
    addPluginConfig,
    createLocalStoragePluginConfigStorage,
    removePluginConfig,
    setPluginEnabled,
    type PluginConfigStorage,
  } from '$lib/plugin-store';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import Checkbox from './ui/Checkbox.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import Input from './ui/Input.svelte';

  interface Props {
    projectPath: string;
    storage?: PluginConfigStorage;
    onChange?: (records: ReturnType<PluginConfigStorage['get']>) => void;
  }

  const {
    projectPath,
    storage = createLocalStoragePluginConfigStorage(projectPath),
    onChange,
  }: Props = $props();

  function readInitialRecords(): ReturnType<PluginConfigStorage['get']> {
    return storage.get();
  }

  let records = $state(readInitialRecords());
  let error = $state<string | undefined>(undefined);

  let newName = $state('');
  let newSource = $state('');

  function handleAdd(): void {
    const name = newName.trim();
    const source = newSource.trim();
    if (!name || !source) {
      error = 'Name and source are required.';
      return;
    }
    const config: PluginConfig = { name, source };
    try {
      records = addPluginConfig(storage, config);
      error = undefined;
      newName = '';
      newSource = '';
      onChange?.(records);
    } catch (err) {
      error = err instanceof PluginConfigError ? err.message : String(err);
    }
  }

  function handleRemove(name: string): void {
    records = removePluginConfig(storage, name);
    onChange?.(records);
  }

  function handleToggle(name: string, enabled: boolean): void {
    records = setPluginEnabled(storage, name, enabled);
    onChange?.(records);
  }
</script>

<div class="plugin-config" data-testid="plugin-config-panel">
  {#if error}
    <ErrorNotice message={error} />
  {/if}

  <Card elevation="raised" padding="md" class="config-section">
    <section class="plugins">
      <h3>Plugins &amp; extensions</h3>
      {#if records.length === 0}
        <EmptyState message="No plugins configured yet." />
      {:else}
        <ul class="plugin-list" data-testid="plugin-list">
          {#each records as record (record.config.name)}
            <li class="plugin-row" data-testid={`plugin-${record.config.name}`}>
              <Checkbox
                checked={record.enabled}
                label={record.config.name}
                onCheckedChange={(checked) => handleToggle(record.config.name, checked)}
                dataTestId={`plugin-enabled-${record.config.name}`}
              />
              <span class="plugin-source">{record.config.source}</span>
              <Button
                variant="danger"
                size="sm"
                class="remove-button"
                onclick={() => handleRemove(record.config.name)}
                dataTestId={`plugin-remove-${record.config.name}`}
              >
                Remove
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </Card>

  <Card elevation="raised" padding="md" class="config-section">
    <section class="add">
      <h3>Add a plugin</h3>
      <div class="add-form">
        <Field label="Name">
          {#snippet children({ id, describedBy, errorId, invalid, required })}
            <Input
              {id}
              {describedBy}
              {errorId}
              {invalid}
              {required}
              bind:value={newName}
              placeholder="e.g. commit-lint"
              dataTestId="plugin-add-name"
            />
          {/snippet}
        </Field>
        <Field label="Source">
          {#snippet children({ id, describedBy, errorId, invalid, required })}
            <Input
              {id}
              {describedBy}
              {errorId}
              {invalid}
              {required}
              monospace
              bind:value={newSource}
              placeholder="e.g. @loombox-plugins/commit-lint"
              dataTestId="plugin-add-source"
            />
          {/snippet}
        </Field>
        <Button variant="primary" size="sm" onclick={handleAdd} dataTestId="plugin-add-submit">
          Add
        </Button>
      </div>
    </section>
  </Card>
</div>

<style>
  .plugin-config {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    font-size: var(--text-small-size);
  }

  :global(.config-section) {
    display: block;
  }

  h3 {
    margin: 0 0 var(--space-sm);
    font-family: var(--font-mono);
    font-size: var(--text-caption-size);
    letter-spacing: var(--text-caption-tracking);
    text-transform: uppercase;
    color: var(--color-text-muted);
    font-weight: 600;
  }

  .plugin-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  /* Quiet hairline-divided rows (redesign brief §4 "Rows"). */
  .plugin-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
    border-top: 1px solid var(--color-border-subtle);
    padding: var(--space-xs) var(--space-2xs);
  }

  .plugin-row:first-child {
    border-top: none;
    padding-top: 0;
  }

  .plugin-source {
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
    font-family: var(--font-mono);
  }

  /* `Button`'s own scope hides this class from the file's hash (same
     `:global()` pattern as `ConfigBar.svelte`'s `.mode-choice`) — only the
     row-positioning this list needs on top of `Button`'s `danger` variant
     lives here now. */
  :global(.remove-button) {
    margin-left: auto;
  }

  .add-form {
    display: flex;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }
</style>
