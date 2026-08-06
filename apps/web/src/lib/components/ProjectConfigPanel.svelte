<script lang="ts">
  /**
   * A selected project's config surface (SPEC.md §7.7; issue #366): the
   * reachable home for the MCP-server quick-add/config panel (#188), the
   * plugin/extension panel (#191), and the per-project test/lint/build
   * command config (SPEC §7.15; issue #245). All three panels shipped
   * fully built and unit-tested separately but were deliberately left
   * unmounted from `+page.svelte` to avoid a parallel-edit clash on that
   * shared file — this component is that mount point, wired in by the
   * caller behind a toggle the same way the file-tree and terminal panels
   * are (see `+page.svelte`'s `fileTreeOpen`/`terminalOpen`).
   *
   * **No Tracker section any more (issue #672, spec §6, F2-2).** The
   * per-project tracker mode picker (SPEC §7.10; issue #220) that used to
   * sit here moved to `TrackerPage.svelte`'s own header/empty-state and
   * was deleted from Config outright, not mirrored — F2-1 (mirror it in
   * both places) was reviewed and not picked, and leaving both would have
   * reintroduced exactly the two-places-for-one-fact problem that decision
   * exists to remove. `TrackerConfigPanel.svelte` still exists; this file
   * is simply no longer one of its callers.
   *
   * Purely a layout wrapper: it owns no config state itself and forwards
   * `projectPath` straight through to every child panel, which stay
   * entirely independent of each other (their own storage keys, their own
   * stores — see `PluginConfigPanel.svelte`'s "isolated from the MCP-server
   * config panel" test). `mcpStorage`/`pluginStorage` are only ever
   * overridden in tests; in the app both default to each panel's own real
   * `localStorage`-backed store, scoped by `projectPath`.
   * `sessionId`/`relayClient` are `TestRunnerConfigPanel`'s and
   * `PermissionPolicyPanel`'s own: unlike their `localStorage` siblings,
   * test/lint/build config and the permission policy genuinely live on
   * the owning node (`TestRunnerConfigStore`/`PermissionPolicyStore`,
   * `@loombox/node`), not `localStorage`, so those two panels need a live
   * session + the real `RelayClient` rather than a storage adapter — see
   * each panel's own doc comment. `relayClient`'s type is the
   * intersection of both panels' own narrow DI interfaces (never a third,
   * looser type invented here) — the real `RelayClient` instance already
   * satisfies both structurally, so `+page.svelte`'s one `relayClient={client}`
   * call site needs no change.
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
   * lives entirely in `McpServerConfigPanel`/`PluginConfigPanel`/
   * `TestRunnerConfigPanel` below it.
   * It already reads every color/spacing/radius value through a token, so
   * this file is otherwise unchanged.
   */
  import type { McpServerConfigStorage } from '$lib/mcp-server-store';
  import type { PluginConfigStorage } from '$lib/plugin-store';
  import type { ProjectEnvDeclStorage } from '$lib/project-env-store';
  import type { AcpMcpServerStatusEntry } from '@loombox/providers-core/browser';
  import McpServerConfigPanel from './McpServerConfigPanel.svelte';
  import PermissionPolicyPanel, {
    type PermissionPolicyClient,
  } from './PermissionPolicyPanel.svelte';
  import PluginConfigPanel from './PluginConfigPanel.svelte';
  import ProjectSecretsPanel from './ProjectSecretsPanel.svelte';
  import SpendReportPanel, { type SpendReportClient } from './SpendReportPanel.svelte';
  import TestRunnerConfigPanel, {
    type TestRunnerConfigClient,
  } from './TestRunnerConfigPanel.svelte';

  type ProjectConfigRelayClient = TestRunnerConfigClient & PermissionPolicyClient & SpendReportClient;

  interface Props {
    projectPath: string;
    sessionId?: string;
    /** The project's owning node (SPEC §7.9; issue #249) — forwarded straight through to `SpendReportPanel`, which is node+project addressed rather than session-addressed (see that panel's own doc comment). `undefined` only for the one render frame before a session's `nodeId` is known, mirroring `sessionId`'s own optionality just above. */
    nodeId?: string;
    mcpStorage?: McpServerConfigStorage;
    pluginStorage?: PluginConfigStorage;
    projectEnvStorage?: ProjectEnvDeclStorage;
    relayClient?: ProjectConfigRelayClient;
    onSecretRequired?: (serverName: string, secretName: string) => void;
    /** Same seam as `onSecretRequired`, scoped to a project's directly-declared env-var injection (issue #258) rather than an MCP server's — kept as its own prop since the two are a genuinely distinct grant/trust boundary (see `ProjectSecretsPanel`'s doc comment). */
    onEnvSecretRequired?: (envVarName: string, secretName: string) => void;
    /**
     * The selected session's latest `mcp_server_status` push (issue #750,
     * D2-2; #794), forwarded straight through to `McpServerConfigPanel`'s
     * own "Server status" section — the caller (`+page.svelte`) already
     * mirrors `RelayClient.mcpServerStatusesFor(sessionId)` for the exact
     * same reason it mirrors `configOptions`/`commands`, so this wrapper
     * stays true to its own "owns no config state itself" contract by
     * only ever passing it through, never subscribing on its own.
     */
    mcpServerStatuses?: AcpMcpServerStatusEntry[];
  }

  const {
    projectPath,
    sessionId,
    nodeId,
    mcpStorage,
    pluginStorage,
    projectEnvStorage,
    relayClient,
    onSecretRequired,
    onEnvSecretRequired,
    mcpServerStatuses,
  }: Props = $props();
</script>

<div class="project-config" data-testid="project-config-panel">
  <section class="project-config-section">
    <h3>MCP servers</h3>
    <McpServerConfigPanel
      {projectPath}
      storage={mcpStorage}
      {onSecretRequired}
      {mcpServerStatuses}
    />
  </section>
  <section class="project-config-section">
    <h3>Env vars &amp; secrets</h3>
    <ProjectSecretsPanel
      {projectPath}
      storage={projectEnvStorage}
      onSecretRequired={onEnvSecretRequired}
    />
  </section>
  <section class="project-config-section">
    <h3>Plugins &amp; extensions</h3>
    <PluginConfigPanel {projectPath} storage={pluginStorage} />
  </section>
  <section class="project-config-section">
    <h3>Test, lint &amp; build</h3>
    <TestRunnerConfigPanel {projectPath} {sessionId} client={relayClient} />
  </section>
  <section class="project-config-section">
    <h3>Permission policy</h3>
    <PermissionPolicyPanel {projectPath} {sessionId} client={relayClient} />
  </section>
  <section class="project-config-section">
    <h3>Spend over time</h3>
    <SpendReportPanel {projectPath} {nodeId} client={relayClient} />
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
