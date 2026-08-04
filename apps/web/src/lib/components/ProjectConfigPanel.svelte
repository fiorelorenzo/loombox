<script lang="ts">
  /**
   * A selected project's config surface (SPEC.md §7.7; issue #366): the
   * reachable home for the MCP-server quick-add/config panel (#188), the
   * plugin/extension panel (#191), the per-project tracker mode picker
   * (SPEC §7.10; issue #220), and the per-project test/lint/build command
   * config (SPEC §7.15; issue #245). All four panels shipped fully built
   * and unit-tested separately but were deliberately left unmounted from
   * `+page.svelte` to avoid a parallel-edit clash on that shared file — this
   * component is that mount point, wired in by the caller behind a toggle
   * the same way the file-tree and terminal panels are (see
   * `+page.svelte`'s `fileTreeOpen`/`terminalOpen`).
   *
   * Tracker sits first, ahead of MCP servers/plugins: it is the one config
   * choice SPEC §7.10 calls "every project chooses, once" — everything a
   * tracker view later reads depends on it having a real answer, so it's
   * the first thing a user seeing this panel for a never-configured
   * project is asked to resolve, not a third peer buried after two
   * unrelated integrations.
   *
   * Purely a layout wrapper: it owns no config state itself and forwards
   * `projectPath` straight through to every child panel, which stay
   * entirely independent of each other (their own storage keys, their own
   * stores — see `PluginConfigPanel.svelte`'s "isolated from the MCP-server
   * config panel" test). `mcpStorage`/`pluginStorage`/`trackerStorage` are
   * only ever overridden in tests; in the app all three default to each
   * panel's own real `localStorage`-backed store, scoped by `projectPath`.
   * `connectedAccounts` is `RelayClient.connectedAccounts`'s live snapshot,
   * forwarded straight to `TrackerConfigPanel` (this wrapper fetches
   * nothing of its own, same as every other prop here). `sessionId`/
   * `relayClient` are `TestRunnerConfigPanel`'s own: unlike its three
   * siblings, test/lint/build config genuinely lives on the owning node
   * (`TestRunnerConfigStore`, `@loombox/node`), not `localStorage`, so
   * that one panel needs a live session + the real `RelayClient` rather
   * than a storage adapter — see `TestRunnerConfigPanel.svelte`'s own doc
   * comment.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §1/§4,
   * issue #435): only the section headers and column rhythm change here —
   * each child panel now carries its own `Card elevation="raised"` chrome,
   * so this wrapper stays a plain two-column layout (stacking at a narrow
   * Drawer width, e.g. the mobile bottom sheet) rather than nesting a
   * second card around cards. `data-testid="project-config-panel"` and the
   * prop contract are unchanged.
   *
   * Deck migration (redesign v2 design spec §2, issue #471): this wrapper
   * owns no button, glyph, or empty/error state of its own (it only lays
   * out its children), so there's nothing here to route through
   * `Button`/`IconButton`/`Icon`/`EmptyState`/`ErrorNotice` — that migration
   * lives entirely in `TrackerConfigPanel`/`McpServerConfigPanel`/
   * `PluginConfigPanel`/`TestRunnerConfigPanel` below it.
   * It already reads every color/spacing/radius value through a token, so
   * this file is otherwise unchanged.
   */
  import type { ConnectedAccount, TrackerMode } from '@loombox/protocol';
  import type { McpServerConfigStorage } from '$lib/mcp-server-store';
  import type { PluginConfigStorage } from '$lib/plugin-store';
  import type { TrackerModeStorage } from '$lib/tracker-mode-store';
  import McpServerConfigPanel from './McpServerConfigPanel.svelte';
  import PluginConfigPanel from './PluginConfigPanel.svelte';
  import TestRunnerConfigPanel, {
    type TestRunnerConfigClient,
  } from './TestRunnerConfigPanel.svelte';
  import TrackerConfigPanel from './TrackerConfigPanel.svelte';

  interface Props {
    projectPath: string;
    sessionId?: string;
    mcpStorage?: McpServerConfigStorage;
    pluginStorage?: PluginConfigStorage;
    trackerStorage?: TrackerModeStorage;
    connectedAccounts?: readonly ConnectedAccount[];
    relayClient?: TestRunnerConfigClient;
    onSecretRequired?: (serverName: string, secretName: string) => void;
    onTrackerModeChange?: (mode: TrackerMode) => void;
  }

  const {
    projectPath,
    sessionId,
    mcpStorage,
    pluginStorage,
    trackerStorage,
    connectedAccounts,
    relayClient,
    onSecretRequired,
    onTrackerModeChange,
  }: Props = $props();
</script>

<div class="project-config" data-testid="project-config-panel">
  <section class="project-config-section">
    <h3>Tracker</h3>
    <TrackerConfigPanel
      {projectPath}
      storage={trackerStorage}
      {connectedAccounts}
      onChange={onTrackerModeChange}
    />
  </section>
  <section class="project-config-section">
    <h3>MCP servers</h3>
    <McpServerConfigPanel {projectPath} storage={mcpStorage} {onSecretRequired} />
  </section>
  <section class="project-config-section">
    <h3>Plugins &amp; extensions</h3>
    <PluginConfigPanel {projectPath} storage={pluginStorage} />
  </section>
  <section class="project-config-section">
    <h3>Test, lint &amp; build</h3>
    <TestRunnerConfigPanel {projectPath} {sessionId} client={relayClient} />
  </section>
</div>

<style>
  .project-config {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xl);
  }

  .project-config-section {
    flex: 1 1 16rem;
    /* Narrow/mobile viewport parity (#174's same fix): lets a section shrink
       inside a narrow flex row instead of forcing horizontal overflow. */
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  h3 {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-caption-size);
    letter-spacing: var(--text-caption-tracking);
    text-transform: uppercase;
    color: var(--color-text-muted);
    font-weight: 600;
  }
</style>
