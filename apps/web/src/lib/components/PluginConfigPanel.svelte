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
   */
  import { PluginConfigError, type PluginConfig } from '@loombox/providers-core';
  import {
    addPluginConfig,
    createLocalStoragePluginConfigStorage,
    removePluginConfig,
    setPluginEnabled,
    type PluginConfigStorage,
  } from '$lib/plugin-store';

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
    <p class="error" data-testid="plugin-config-error">{error}</p>
  {/if}

  <section class="plugins">
    <h3>Plugins &amp; extensions</h3>
    {#if records.length === 0}
      <p class="empty">No plugins configured yet.</p>
    {:else}
      <ul class="plugin-list" data-testid="plugin-list">
        {#each records as record (record.config.name)}
          <li data-testid={`plugin-${record.config.name}`}>
            <label>
              <input
                type="checkbox"
                checked={record.enabled}
                onchange={(event) =>
                  handleToggle(
                    record.config.name,
                    (event.currentTarget as HTMLInputElement).checked,
                  )}
                data-testid={`plugin-enabled-${record.config.name}`}
              />
              <span class="plugin-name">{record.config.name}</span>
              <span class="plugin-source">{record.config.source}</span>
            </label>
            <button
              type="button"
              class="remove"
              onclick={() => handleRemove(record.config.name)}
              data-testid={`plugin-remove-${record.config.name}`}
            >
              Remove
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="add">
    <h3>Add a plugin</h3>
    <div class="add-form">
      <input type="text" placeholder="Name" bind:value={newName} data-testid="plugin-add-name" />
      <input
        type="text"
        placeholder="Source"
        bind:value={newSource}
        data-testid="plugin-add-source"
      />
      <button type="button" onclick={handleAdd} data-testid="plugin-add-submit">Add</button>
    </div>
  </section>
</div>

<style>
  .plugin-config {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    font-size: var(--text-small-size);
  }

  h3 {
    margin: 0 0 var(--space-xs);
    font-size: 0.8rem;
    opacity: 0.7;
    font-weight: 600;
  }

  .error {
    color: var(--color-danger);
    margin: 0;
  }

  .plugin-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .plugin-list li {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .plugin-source {
    opacity: 0.55;
    font-size: var(--text-small-size);
  }

  .remove {
    margin-left: auto;
  }

  .add-form {
    display: flex;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .empty {
    opacity: 0.6;
    margin: 0;
  }
</style>
