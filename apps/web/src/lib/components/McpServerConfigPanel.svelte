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
   * rather than a dim one-line paragraph.
   *
   * Deck migration (redesign v2 design spec §2, issue #471): every per-item
   * button (quick-add, remove, manual submit) now routes through the shared
   * `Button` primitive, using its `dataTestId` override (issue #479, which
   * landed after #434/#435's tradeoff note below was written) to keep this
   * surface's exact per-server/per-preset ids (`preset-add-${name}`,
   * `server-remove-${name}`, …) — the earlier `PushNotificationToggle`/
   * `AppearanceSettings` hand-styled-instead-of-imported workaround is no
   * longer needed for these. The duplicate-add/error text now renders
   * through the real `ErrorNotice` primitive; the test that used to key off
   * its fixed `mcp-config-error` testid now asserts on the visible message
   * text instead (mirrors `TargetStatusView.test.ts`'s pattern), since
   * `ErrorNotice`'s own root testid has no override. The quick-add rows'
   * decorative "+" glyph is dropped rather than routed through the shared
   * `Icon` component: the bespoke icon set (issue #457) has no generic
   * "add" glyph, and each preset's name is already the button's visible
   * label. The root's `data-testid="mcp-config-panel"` and every other
   * `data-testid` are unchanged; only markup/CSS move.
   */
  import {
    MCP_SERVER_PRESET_CATALOG,
    McpServerConfigError,
    type McpServerConfig,
    type McpServerPreset,
  } from '@loombox/providers-core/browser';
  import {
    addMcpServerConfig,
    addMcpServerFromPreset,
    createLocalStorageMcpServerConfigStorage,
    removeMcpServerConfig,
    requiredSecretNames,
    setMcpServerEnabled,
    type McpServerConfigStorage,
  } from '$lib/mcp-server-store';
  import Badge from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import Checkbox from './ui/Checkbox.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import Input from './ui/Input.svelte';

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
    <ErrorNotice message={error} />
  {/if}

  <Card elevation="raised" padding="md" class="config-section">
    <section class="quick-add">
      <h3>Quick-add</h3>
      <ul class="preset-list">
        {#each catalog as preset (preset.config.name)}
          <li class="preset-row">
            <Button
              variant="secondary"
              size="sm"
              dataTestId={`preset-add-${preset.config.name}`}
              onclick={() => handleQuickAdd(preset)}
            >
              {preset.config.name}
            </Button>
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
              <Checkbox
                checked={record.enabled}
                label={record.config.name}
                onCheckedChange={(checked) => handleToggle(record.config.name, checked)}
                dataTestId={`server-enabled-${record.config.name}`}
              />
              <span class="server-transport">{record.config.transport}</span>
              {#each requiredSecretNames(record.config) as secretName (secretName)}
                <Badge
                  tone="warning"
                  dataTestId={`server-secret-badge-${record.config.name}-${secretName}`}
                >
                  Needs secret: {secretName}
                </Badge>
              {/each}
              <Button
                variant="danger"
                size="sm"
                class="remove-button"
                onclick={() => handleRemove(record.config.name)}
                dataTestId={`server-remove-${record.config.name}`}
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
    <section class="manual-add">
      <h3>Add a custom server</h3>
      <div class="manual-form">
        <Field label="Server name">
          {#snippet children({ id, describedBy, errorId, invalid, required })}
            <Input
              {id}
              {describedBy}
              {errorId}
              {invalid}
              {required}
              bind:value={manualName}
              placeholder="e.g. filesystem"
              dataTestId="manual-add-name"
            />
          {/snippet}
        </Field>
        <Field label="Command">
          {#snippet children({ id, describedBy, errorId, invalid, required })}
            <Input
              {id}
              {describedBy}
              {errorId}
              {invalid}
              {required}
              monospace
              bind:value={manualCommand}
              placeholder="e.g. npx @modelcontextprotocol/server-filesystem"
              dataTestId="manual-add-command"
            />
          {/snippet}
        </Field>
        <Field label="Args (comma separated)">
          {#snippet children({ id, describedBy, errorId, invalid, required })}
            <Input
              {id}
              {describedBy}
              {errorId}
              {invalid}
              {required}
              monospace
              bind:value={manualArgs}
              placeholder="e.g. --root, /home/user"
              dataTestId="manual-add-args"
            />
          {/snippet}
        </Field>
        <Button
          variant="primary"
          size="sm"
          onclick={handleManualAdd}
          dataTestId="manual-add-submit"
        >
          Add
        </Button>
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
    font-size: var(--text-caption-size);
    letter-spacing: var(--text-caption-tracking);
    text-transform: uppercase;
    color: var(--color-text-muted);
    font-weight: 600;
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
    font-size: var(--text-small-size);
  }

  .server-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .server-transport {
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

  .manual-form {
    display: flex;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }
</style>
