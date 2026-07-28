<script lang="ts">
  /**
   * A selected project's config surface (SPEC.md §7.7; issue #366): the
   * reachable home for the MCP-server quick-add/config panel (#188) and the
   * plugin/extension panel (#191). Both panels shipped fully built and
   * unit-tested in #364 but were deliberately left unmounted from
   * `+page.svelte` to avoid a parallel-edit clash on that shared file — this
   * component is that mount point, wired in by the caller behind a toggle
   * the same way the file-tree and terminal panels are (see
   * `+page.svelte`'s `fileTreeOpen`/`terminalOpen`).
   *
   * Purely a layout wrapper: it owns no config state itself and forwards
   * `projectPath` straight through to both panels, which stay entirely
   * independent of each other (their own storage keys, their own stores —
   * see `PluginConfigPanel.svelte`'s "isolated from the MCP-server config
   * panel" test). `mcpStorage`/`pluginStorage` are only ever overridden in
   * tests; in the app both default to each panel's own real
   * `localStorage`-backed store, scoped by `projectPath`.
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
   * out its two children), so there's nothing here to route through
   * `Button`/`IconButton`/`Icon`/`EmptyState`/`ErrorNotice` — that migration
   * lives entirely in `McpServerConfigPanel`/`PluginConfigPanel` below it.
   * It already reads every color/spacing/radius value through a token, so
   * this file is otherwise unchanged.
   */
  import type { McpServerConfigStorage } from '$lib/mcp-server-store';
  import type { PluginConfigStorage } from '$lib/plugin-store';
  import McpServerConfigPanel from './McpServerConfigPanel.svelte';
  import PluginConfigPanel from './PluginConfigPanel.svelte';

  interface Props {
    projectPath: string;
    mcpStorage?: McpServerConfigStorage;
    pluginStorage?: PluginConfigStorage;
    onSecretRequired?: (serverName: string, secretName: string) => void;
  }

  const { projectPath, mcpStorage, pluginStorage, onSecretRequired }: Props = $props();
</script>

<div class="project-config" data-testid="project-config-panel">
  <section class="project-config-section">
    <h3>MCP servers</h3>
    <McpServerConfigPanel {projectPath} storage={mcpStorage} {onSecretRequired} />
  </section>
  <section class="project-config-section">
    <h3>Plugins &amp; extensions</h3>
    <PluginConfigPanel {projectPath} storage={pluginStorage} />
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
