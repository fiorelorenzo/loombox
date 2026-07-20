<script lang="ts">
  /**
   * A project's MCP server config surface (SPEC.md §7.7; issues #187/#188):
   * lists the project's currently declared servers (enable/disable/remove),
   * a quick-add row over the starter preset catalog
   * (`@loombox/providers-core`'s `MCP_SERVER_PRESET_CATALOG`), and a manual
   * "add a custom server" form — both of which funnel through the exact
   * same `mcp-server-store.ts` functions
   * (`addMcpServerFromPreset`/`addMcpServerConfig`), so a quick-added
   * preset and a hand-typed server always end up as the identical
   * `McpServerConfigRecord` shape in the list below. There is no
   * preset-only rendering path: both appear in the same "Configured
   * servers" list once added.
   *
   * A server whose config declares a required secret (an `{ name, secret }`
   * env var/header — never a literal value, enforced by the data model
   * itself) renders a "needs secret" badge rather than silently omitting
   * it. Actually resolving that secret into a value is a node-local
   * concern this panel has no access to (§7.17's node-local-secrets rule);
   * `onSecretRequired` is the seam a real secret-grant prompt hangs off —
   * this panel calls it once per required secret whenever a server is
   * added, but stops there.
   */
  import {
    MCP_SERVER_PRESET_CATALOG,
    McpServerConfigError,
    type McpServerConfig,
    type McpServerPreset,
  } from '@loombox/providers-core';
  import {
    addMcpServerConfig,
    addMcpServerFromPreset,
    createLocalStorageMcpServerConfigStorage,
    removeMcpServerConfig,
    requiredSecretNames,
    setMcpServerEnabled,
    type McpServerConfigStorage,
  } from '$lib/mcp-server-store';

  interface Props {
    projectPath: string;
    storage?: McpServerConfigStorage;
    catalog?: readonly McpServerPreset[];
    onChange?: (records: ReturnType<McpServerConfigStorage['get']>) => void;
    onSecretRequired?: (serverName: string, secretName: string) => void;
  }

  const {
    projectPath,
    storage = createLocalStorageMcpServerConfigStorage(projectPath),
    catalog = MCP_SERVER_PRESET_CATALOG,
    onChange,
    onSecretRequired,
  }: Props = $props();

  // One-shot initial read into a plain local before seeding `$state`, same
  // pattern as `NotificationPreferences.svelte`'s `readInitialPreferences`
  // — referencing the `storage` prop directly inside a `$state` initializer
  // triggers Svelte 5's "only captures the initial value" warning.
  function readInitialRecords(): ReturnType<McpServerConfigStorage['get']> {
    return storage.get();
  }

  let records = $state(readInitialRecords());
  let error = $state<string | undefined>(undefined);

  let manualName = $state('');
  let manualCommand = $state('');
  let manualArgs = $state('');

  function announceSecrets(config: McpServerConfig): void {
    for (const secretName of requiredSecretNames(config)) {
      onSecretRequired?.(config.name, secretName);
    }
  }

  function applyAdd(next: ReturnType<McpServerConfigStorage['get']>, added: McpServerConfig): void {
    records = next;
    error = undefined;
    announceSecrets(added);
    onChange?.(next);
  }

  function handleQuickAdd(preset: McpServerPreset): void {
    try {
      applyAdd(addMcpServerFromPreset(storage, preset), preset.config);
    } catch (err) {
      error = err instanceof McpServerConfigError ? err.message : String(err);
    }
  }

  function handleManualAdd(): void {
    const name = manualName.trim();
    const command = manualCommand.trim();
    if (!name || !command) {
      error = 'Name and command are required.';
      return;
    }
    const config: McpServerConfig = {
      name,
      transport: 'stdio',
      command,
      args: manualArgs
        .split(',')
        .map((arg) => arg.trim())
        .filter((arg) => arg.length > 0),
      env: [],
    };
    try {
      applyAdd(addMcpServerConfig(storage, config), config);
      manualName = '';
      manualCommand = '';
      manualArgs = '';
    } catch (err) {
      error = err instanceof McpServerConfigError ? err.message : String(err);
    }
  }

  function handleRemove(name: string): void {
    records = removeMcpServerConfig(storage, name);
    onChange?.(records);
  }

  function handleToggle(name: string, enabled: boolean): void {
    records = setMcpServerEnabled(storage, name, enabled);
    onChange?.(records);
  }
</script>

<div class="mcp-config" data-testid="mcp-config-panel">
  {#if error}
    <p class="error" data-testid="mcp-config-error">{error}</p>
  {/if}

  <section class="quick-add">
    <h3>Quick-add</h3>
    <ul class="preset-list">
      {#each catalog as preset (preset.config.name)}
        <li>
          <button
            type="button"
            data-testid={`preset-add-${preset.config.name}`}
            onclick={() => handleQuickAdd(preset)}
          >
            + {preset.config.name}
          </button>
          <span class="preset-description">{preset.description}</span>
        </li>
      {/each}
    </ul>
  </section>

  <section class="servers">
    <h3>Configured servers</h3>
    {#if records.length === 0}
      <p class="empty">No MCP servers configured yet.</p>
    {:else}
      <ul class="server-list" data-testid="mcp-server-list">
        {#each records as record (record.config.name)}
          <li data-testid={`mcp-server-${record.config.name}`}>
            <label>
              <input
                type="checkbox"
                checked={record.enabled}
                onchange={(event) =>
                  handleToggle(
                    record.config.name,
                    (event.currentTarget as HTMLInputElement).checked,
                  )}
                data-testid={`server-enabled-${record.config.name}`}
              />
              <span class="server-name">{record.config.name}</span>
              <span class="server-transport">{record.config.transport}</span>
            </label>
            {#each requiredSecretNames(record.config) as secretName (secretName)}
              <span
                class="secret-badge"
                data-testid={`server-secret-badge-${record.config.name}-${secretName}`}
              >
                Needs secret: {secretName}
              </span>
            {/each}
            <button
              type="button"
              class="remove"
              onclick={() => handleRemove(record.config.name)}
              data-testid={`server-remove-${record.config.name}`}
            >
              Remove
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="manual-add">
    <h3>Add a custom server</h3>
    <div class="manual-form">
      <input
        type="text"
        placeholder="Server name"
        bind:value={manualName}
        data-testid="manual-add-name"
      />
      <input
        type="text"
        placeholder="Command"
        bind:value={manualCommand}
        data-testid="manual-add-command"
      />
      <input
        type="text"
        placeholder="Args (comma separated)"
        bind:value={manualArgs}
        data-testid="manual-add-args"
      />
      <button type="button" onclick={handleManualAdd} data-testid="manual-add-submit">Add</button>
    </div>
  </section>
</div>

<style>
  .mcp-config {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    font-size: 0.85rem;
  }

  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.8rem;
    opacity: 0.7;
    font-weight: 600;
  }

  .error {
    color: #dc2626;
    margin: 0;
  }

  .preset-list,
  .server-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .preset-list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .preset-description {
    opacity: 0.6;
    font-size: 0.78rem;
  }

  .server-list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .server-transport {
    opacity: 0.55;
    font-size: 0.75rem;
  }

  .secret-badge {
    background: rgba(220, 38, 38, 0.12);
    color: #dc2626;
    border-radius: 0.3rem;
    padding: 0.1rem 0.4rem;
    font-size: 0.72rem;
  }

  .remove {
    margin-left: auto;
  }

  .manual-form {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .empty {
    opacity: 0.6;
    margin: 0;
  }
</style>
