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
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §3/§4/§6,
   * issue #435): the three sections (quick-add, configured servers, manual
   * add) each sit on their own `Card elevation="raised"` (the elevation
   * table's documented home for "MCP/plugin config cards"), the configured
   * list becomes quiet hairline-divided rows with a tactile toggle switch
   * instead of a bare checkbox, and an empty list reads through `EmptyState`
   * rather than a dim one-line paragraph. Every per-item control (quick-add
   * buttons, the enable toggle, remove) keeps its exact existing
   * `data-testid` and is hand-styled to `Button`/`IconButton`'s visual
   * language rather than importing those primitives directly: both
   * primitives hardcode their own `data-testid` with no override, and this
   * surface's tests key off the per-server/per-preset ids
   * (`preset-add-${name}`, `server-remove-${name}`, …), the same tradeoff
   * already made for `PushNotificationToggle`/`AppearanceSettings` (#434).
   * The root's `data-testid="mcp-config-panel"` and every other
   * `data-testid` are unchanged; only markup/CSS/motion move.
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
  import Card from './ui/Card.svelte';
  import EmptyState from './ui/EmptyState.svelte';

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
    <p class="config-error" role="alert" data-testid="mcp-config-error">{error}</p>
  {/if}

  <Card elevation="raised" padding="md" class="config-section">
    <section class="quick-add">
      <h3>Quick-add</h3>
      <ul class="preset-list">
        {#each catalog as preset (preset.config.name)}
          <li class="preset-row">
            <button
              type="button"
              class="pill-button"
              data-testid={`preset-add-${preset.config.name}`}
              onclick={() => handleQuickAdd(preset)}
            >
              <span class="pill-icon" aria-hidden="true">
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M10 4v12M4 10h12" stroke-linecap="round" />
                </svg>
              </span>
              {preset.config.name}
            </button>
            <span class="preset-description">{preset.description}</span>
          </li>
        {/each}
      </ul>
    </section>
  </Card>

  <Card elevation="raised" padding="md" class="config-section">
    <section class="servers">
      <h3>Configured servers</h3>
      {#if records.length === 0}
        <EmptyState message="No MCP servers configured yet." />
      {:else}
        <ul class="server-list" data-testid="mcp-server-list">
          {#each records as record (record.config.name)}
            <li class="server-row" data-testid={`mcp-server-${record.config.name}`}>
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
                    data-testid={`server-enabled-${record.config.name}`}
                  />
                  <span class="toggle-switch-track" aria-hidden="true"></span>
                </span>
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
                class="remove-button"
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
  </Card>

  <Card elevation="raised" padding="md" class="config-section">
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
        <button
          type="button"
          class="submit-button"
          onclick={handleManualAdd}
          data-testid="manual-add-submit"
        >
          Add
        </button>
      </div>
    </section>
  </Card>
</div>

<style>
  .mcp-config {
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

  .preset-list,
  .server-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  /* Quiet hairline-divided rows (redesign brief §4 "Rows"), not boxed
     cards, so a long list stays scannable. */
  .preset-row,
  .server-row {
    border-top: 1px solid var(--color-border-subtle);
    padding: var(--space-xs) var(--space-2xs);
  }

  .preset-row:first-child,
  .server-row:first-child {
    border-top: none;
    padding-top: 0;
  }

  .preset-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .preset-description {
    color: var(--color-text-secondary);
    font-size: 0.78rem;
  }

  /* Hand-styled to `Button`'s `secondary` visual language (border-strong,
     transparent fill, tension-press) rather than importing `Button`
     itself — see the file doc comment for why: `Button` hardcodes
     `data-testid="ui-button"` and this row needs a unique
     `preset-add-${name}` id per test. */
  .pill-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    font: inherit;
    font-weight: 600;
    padding: var(--space-2xs) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border-strong);
    background: transparent;
    color: var(--color-text-primary);
    cursor: pointer;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .pill-button:hover {
    background: var(--color-fill-subtle);
  }

  /* tension-press (redesign brief §2). */
  .pill-button:active {
    background: var(--color-fill);
    transform: scale(0.98);
  }

  .pill-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .pill-icon {
    display: inline-flex;
    width: 0.9rem;
    height: 0.9rem;
  }

  .pill-icon svg {
    width: 100%;
    height: 100%;
  }

  .server-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    cursor: pointer;
  }

  .server-name {
    color: var(--color-text-primary);
  }

  .server-transport {
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
    font-family: var(--font-mono);
  }

  .secret-badge {
    background: var(--color-warning-subtle);
    color: var(--color-warning);
    border-radius: var(--radius-sm);
    padding: var(--space-3xs) var(--space-xs);
    font-size: 0.72rem;
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
     as the plain checkbox this replaces visually (mirrors the
     `NotificationPreferences`/#434 pattern). */
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

  .manual-form {
    display: flex;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .manual-form input {
    flex: 1 1 10rem;
    font: inherit;
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: inherit;
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .manual-form input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* Hand-styled to `Button`'s `primary` visual language — same rationale
     as `.pill-button` above. */
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
    .pill-button,
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

    .manual-form input {
      min-height: 2.75rem;
      font-size: 1rem;
    }
  }
</style>
