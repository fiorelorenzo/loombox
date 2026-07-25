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
   * `EmptyState`. Per-item controls keep their existing `data-testid` and
   * are hand-styled to `Button`'s visual language rather than importing it
   * (it hardcodes its own `data-testid` with no override) — same tradeoff
   * as `McpServerConfigPanel`'s restyle and #434's settings restyle.
   */
  import { PluginConfigError, type PluginConfig } from '@loombox/providers-core';
  import {
    addPluginConfig,
    createLocalStoragePluginConfigStorage,
    removePluginConfig,
    setPluginEnabled,
    type PluginConfigStorage,
  } from '$lib/plugin-store';
  import Card from './ui/Card.svelte';
  import EmptyState from './ui/EmptyState.svelte';

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
    <p class="config-error" role="alert" data-testid="plugin-config-error">{error}</p>
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
              <label class="toggle-row">
                <span class="toggle-switch">
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
                  <span class="toggle-switch-track" aria-hidden="true"></span>
                </span>
                <span class="plugin-name">{record.config.name}</span>
                <span class="plugin-source">{record.config.source}</span>
              </label>
              <button
                type="button"
                class="remove-button"
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
  </Card>

  <Card elevation="raised" padding="md" class="config-section">
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
        <button
          type="button"
          class="submit-button"
          onclick={handleAdd}
          data-testid="plugin-add-submit"
        >
          Add
        </button>
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
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text-muted);
    font-weight: 600;
  }

  .config-error {
    margin: 0;
    padding: var(--space-sm) var(--space-lg);
    border-radius: var(--radius-lg);
    background: var(--color-danger-subtle);
    border: 1px solid var(--color-danger);
    color: var(--color-danger);
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

  .toggle-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    cursor: pointer;
  }

  .plugin-name {
    color: var(--color-text-primary);
  }

  .plugin-source {
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
    font-family: var(--font-mono);
  }

  .remove-button {
    margin-left: auto;
    font: inherit;
    font-weight: 600;
    padding: var(--space-2xs) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-danger);
    background: transparent;
    color: var(--color-danger);
    cursor: pointer;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .remove-button:hover,
  .remove-button:active {
    background: var(--color-danger-subtle);
  }

  .remove-button:active {
    transform: scale(0.98);
  }

  .remove-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* A tactile toggle switch built on a real, still-fully-functional
     `<input type="checkbox">` — only `appearance` is suppressed, so
     `checked`/`onchange`/`data-testid` behavior is byte-for-byte the same
     as the plain checkbox this replaces visually. */
  .toggle-switch {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    width: 2rem;
    height: 1.15rem;
  }

  .toggle-switch input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
    z-index: 1;
  }

  .toggle-switch-track {
    position: absolute;
    inset: 0;
    border-radius: var(--radius-full);
    background: var(--color-fill);
    border: 1px solid var(--color-border);
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .toggle-switch-track::before {
    content: '';
    position: absolute;
    top: 1px;
    left: 1px;
    width: calc(1.15rem - 4px);
    height: calc(1.15rem - 4px);
    border-radius: var(--radius-full);
    background: var(--color-text-secondary);
    transition:
      transform var(--duration-fast) var(--ease-beat),
      background-color var(--duration-fast) var(--ease-beat);
  }

  .toggle-switch input:checked + .toggle-switch-track {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
  }

  .toggle-switch input:checked + .toggle-switch-track::before {
    background: var(--color-accent);
    transform: translateX(calc(2rem - 1.15rem));
  }

  .toggle-switch input:focus-visible + .toggle-switch-track {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .add-form {
    display: flex;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .add-form input {
    flex: 1 1 10rem;
    font: inherit;
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: inherit;
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .add-form input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* Hand-styled to `Button`'s `primary` visual language — same rationale
     as the file doc comment. */
  .submit-button {
    font: inherit;
    font-weight: 600;
    padding: var(--space-2xs) var(--space-lg);
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    cursor: pointer;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .submit-button:hover {
    background: var(--color-accent-hover);
  }

  .submit-button:active {
    background: var(--color-accent-active);
    transform: scale(0.98);
  }

  .submit-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133): the same 44px
     coarse-pointer convention `Button`/`CopyButton` already use. */
  @media (pointer: coarse) {
    .remove-button,
    .submit-button {
      min-height: 2.75rem;
    }

    .toggle-switch {
      width: 2.75rem;
      height: 1.5rem;
    }

    .toggle-switch-track::before {
      width: calc(1.5rem - 4px);
      height: calc(1.5rem - 4px);
    }

    .toggle-switch input:checked + .toggle-switch-track::before {
      transform: translateX(calc(2.75rem - 1.5rem));
    }

    .add-form input {
      min-height: 2.75rem;
      font-size: 1rem;
    }
  }
</style>
