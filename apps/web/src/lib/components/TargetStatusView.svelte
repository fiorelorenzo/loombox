<script lang="ts">
  /**
   * The node/target status view (SPEC §7.21; issue #269): every known node
   * and target with reachability, agent-process health, and CPU/RAM/disk,
   * reusing #253's per-target sampling (`TargetListEntry.health`) fanned
   * out over `RelayClient.listTargets()`. Purely presentational, mirroring
   * `TargetPicker.svelte`'s split — `+page.svelte` owns polling
   * `listTargets()` on an interval (issue #269's "refreshed on a regular
   * interval") and passes the latest snapshot plus loading/error state in.
   *
   * Distinguishes the three causes a stalled session's target can have
   * (issue #269's acceptance, "overload vs. unreachable vs. process
   * crash"):
   * - `reachable: false` — this target's owning **node** has no live relay
   *   connection at all ("Node offline").
   * - `reachable: true` but `health.healthy === false` — the node is up,
   *   but the sampler's own probe against *this* target failed (an `ssh:`
   *   exec error) — the target itself is unreachable/crashed even though
   *   its node is fine ("Unreachable").
   * - `reachable: true`, `health.healthy === true`, but CPU/RAM/disk is
   *   pinned near capacity — the target is up and sampling fine, just
   *   under load ("Overloaded"), the §7.16 concern this same sampling data
   *   also feeds.
   * - Anything else with a health reading is "Healthy"; no reading yet at
   *   all (a node that hasn't completed its first sample tick) is
   *   "No data yet" rather than any of the above.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §3/§4/§6,
   * issue #436): each row keeps its `raised` elevation tier but gains a
   * quiet left-edge stripe keyed by `healthState`, mirroring
   * `AttentionInbox`'s treatment so both attention surfaces read as one
   * family; the health badge grows a `StatusDot` alongside its (now
   * larger) text, and the CPU/RAM/disk meters switch from a plain `width`
   * transition to the shared `thread-draw-fill` primitive
   * (`$lib/styles/motion.css`). Empty and error states adopt the shared
   * `EmptyState`/`ErrorNotice` primitives. All `data-testid`s, DOM
   * structure the tests query, `focusTarget` highlighting, and every
   * callback contract are unchanged.
   *
   * Deck migration (redesign v2 §2 "one button language" / issue #466):
   * the Refresh header action rendered through the real `ui/Button`
   * rather than hand-styled `.header-btn` markup, using `Button`'s
   * `dataTestId` override (issue #460) to keep its existing
   * `target-status-refresh` selector — since replaced by an `IconButton`
   * below (redesign v3). The health
   * badge also gains a shape-coded glyph from the bespoke icon set
   * (`health-ok`/`health-warn`/`health-danger`) next to its `StatusDot`, so
   * the state reads by shape as well as color (no icon is drawn for the
   * neutral `no-data` state, which has none in the set — the dot alone
   * still carries it). Every remaining literal color/spacing/radius value
   * in this file's own styles is now a token.
   *
   * Connection management (redesign v2 §3.3; issue #476): each row gains
   * Reconnect/Update/Remove/Edit actions through `ui/Button` — entirely
   * additive behind the new optional `client` prop, so a caller that never
   * passes one (every existing call site, until a follow-up wires it) keeps
   * today's exact read-only view. Reconnect has no wire message of its own
   * (an `ssh:` target's transport already auto-reconnects on next use); it
   * just re-runs `onRefresh` for a fresh reachable/health read. Update and
   * Remove call `client.updateTarget`/`decommissionTarget`; Remove requires
   * an explicit confirm step first. Edit reuses `AddTargetWizard` itself
   * (100% of the same tested add-target machinery) rather than a second
   * form, opened in its `editing` mode — see that component's own doc
   * comment for what "prefilled from the target being edited" honestly
   * means given `TargetListEntry` never carries a target's connection
   * recipe (SPEC §8's crypto boundary).
   *
   * Panel chrome (redesign v3 design spec §3.6 `D2`): this view no longer
   * repeats its own "Nodes & targets" title or a Close action — the
   * Drawer that hosts it already renders both — so its own header
   * collapses to just the Refresh action, now a compact `IconButton`
   * rather than a labeled `Button`. `onClose` is gone from its props;
   * the caller (`+page.svelte`'s Drawer) owns closing the panel.
   */
  import type {
    DecommissionTargetResponse,
    TargetHealth,
    TargetListEntry,
    TargetUpdateResponse,
  } from '$lib/relay-client';
  import WovenLoader from './WovenLoader.svelte';
  import StatusDot, { type StatusTone } from './ui/StatusDot.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import { Icon, type IconName } from './icons';
  import AddTargetWizard, {
    type AddTargetClient,
    type EditingTarget,
  } from './AddTargetWizard.svelte';
  import { SvelteSet } from 'svelte/reactivity';

  /** `TargetStatusView`'s own action surface on top of `AddTargetWizard`'s add/edit contract (issue #476) — `decommissionTarget`/`updateTarget` are required here (unlike `AddTargetClient`'s optional `decommissionTarget`), since every action this view offers besides Edit needs them the moment a `client` is passed at all. */
  export interface TargetActionsClient extends AddTargetClient {
    decommissionTarget: (
      options: { nodeId: string; targetId: string; removeFiles?: boolean },
      timeoutMs?: number,
    ) => Promise<DecommissionTargetResponse>;
    updateTarget: (
      options: { nodeId: string; targetId: string },
      timeoutMs?: number,
    ) => Promise<TargetUpdateResponse>;
  }

  export interface FocusTarget {
    nodeId: string;
    targetId: string;
  }

  interface Props {
    targets: TargetListEntry[];
    /** True only for the first, still-in-flight fetch — a background refresh reusing an existing list never re-shows this. */
    loading: boolean;
    error: string | undefined;
    onRefresh: () => void;
    /** A specific node/target to highlight (issue #269's "a stalled session's view links back to this status view for its target") — e.g. `+page.svelte` sets this from the session row the user clicked through from. */
    focusTarget?: FocusTarget;
    /** Enables the per-target Reconnect/Update/Remove/Edit actions (redesign v2 §3.3; issue #476) — omit to keep this view exactly as read-only as before. */
    client?: TargetActionsClient;
  }

  const { targets, loading, error, onRefresh, focusTarget, client }: Props = $props();

  /** In-flight Update/Remove calls, keyed by {@link rowKey} — disables that row's own buttons and drives `Button`'s `loading` state without a page-wide spinner. `SvelteSet` (not a plain `Set` wrapped in `$state`, mirrors `FileTreePanel.svelte`'s own `expandedPaths`) so `.add`/`.delete` are reactive in place, no reassignment needed. */
  const busyKeys = new SvelteSet<string>();
  /** Rows currently showing Remove's "are you sure" confirm bar instead of its plain button, keyed by {@link rowKey}. */
  const confirmingRemove = new SvelteSet<string>();
  /** The last Update/Remove outcome message per row, keyed by {@link rowKey} — cleared implicitly the next time either action runs on that row. */
  let actionMessages = $state<Record<string, string>>({});
  let editWizardOpen = $state(false);
  let editingTarget = $state<EditingTarget | undefined>(undefined);

  /** The overload threshold this view flags — deliberately not configurable at v1 (a fixed, documented figure is more legible than a per-target setting nobody has looked at yet); §7.16's own configurable per-target limits are the future consumer of this same sampling data. */
  const OVERLOAD_PERCENT = 90;

  function rowKey(target: TargetListEntry): string {
    return `${target.nodeId}:${target.targetId}`;
  }

  function isFocused(target: TargetListEntry): boolean {
    return (
      focusTarget !== undefined &&
      focusTarget.nodeId === target.nodeId &&
      focusTarget.targetId === target.targetId
    );
  }

  type HealthState = 'no-data' | 'node-offline' | 'unreachable' | 'overloaded' | 'healthy';

  function healthState(target: TargetListEntry): HealthState {
    if (!target.reachable) return 'node-offline';
    if (!target.health) return 'no-data';
    if (!target.health.healthy) return 'unreachable';
    const { cpuPercent, memPercent, diskPercent } = target.health;
    if (
      cpuPercent >= OVERLOAD_PERCENT ||
      memPercent >= OVERLOAD_PERCENT ||
      diskPercent >= OVERLOAD_PERCENT
    ) {
      return 'overloaded';
    }
    return 'healthy';
  }

  const HEALTH_LABELS: Record<HealthState, string> = {
    'no-data': 'No data yet',
    'node-offline': 'Node offline',
    unreachable: 'Unreachable',
    overloaded: 'Overloaded',
    healthy: 'Healthy',
  };

  /** Maps `HealthState` onto the shared `StatusDot` tone vocabulary — the same four semantic colors this view's own badge already carries, just also driving the dot. */
  const HEALTH_TONES: Record<HealthState, StatusTone> = {
    'no-data': 'neutral',
    'node-offline': 'danger',
    unreachable: 'danger',
    overloaded: 'warning',
    healthy: 'success',
  };

  /** Pairs the badge's `StatusDot` with a shape-distinct glyph from the bespoke icon set, so the state doesn't rely on color alone — `no-data` has no dedicated icon in the set and falls back to the dot only. */
  const HEALTH_ICONS: Partial<Record<HealthState, IconName>> = {
    'node-offline': 'health-danger',
    unreachable: 'health-danger',
    overloaded: 'health-warn',
    healthy: 'health-ok',
  };

  function meterLevel(percent: number): 'ok' | 'elevated' | 'high' {
    if (percent >= OVERLOAD_PERCENT) return 'high';
    if (percent >= 75) return 'elevated';
    return 'ok';
  }

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
    const value = bytes / 2 ** (10 * exponent);
    return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
  }

  function formatSampledAt(health: TargetHealth): string {
    const ageMs = Date.now() - health.sampledAt;
    if (ageMs < 5_000) return 'just now';
    if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
    if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
    return `${Math.round(ageMs / 3_600_000)}h ago`;
  }

  /**
   * "Reconnect" (redesign v2 §3.3; issue #476): there is no reconnect wire
   * message at all (`@loombox/protocol`'s `target-lifecycle.ts` doc comment)
   * — an `ssh:` target's pooled transport already auto-reconnects on next
   * use, so the one useful thing a client can do is ask for a fresh
   * reachable/health read, exactly what the header's own Refresh button
   * already does.
   */
  function reconnect(): void {
    onRefresh();
  }

  async function runUpdate(target: TargetListEntry): Promise<void> {
    if (!client) return;
    const key = rowKey(target);
    busyKeys.add(key);
    try {
      const response = await client.updateTarget({
        nodeId: target.nodeId,
        targetId: target.targetId,
      });
      actionMessages = { ...actionMessages, [key]: response.message };
      if (response.ok) onRefresh();
    } catch (error) {
      actionMessages = {
        ...actionMessages,
        [key]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      busyKeys.delete(key);
    }
  }

  function startRemove(target: TargetListEntry): void {
    confirmingRemove.add(rowKey(target));
  }

  function cancelRemove(target: TargetListEntry): void {
    confirmingRemove.delete(rowKey(target));
  }

  async function confirmRemove(target: TargetListEntry): Promise<void> {
    if (!client) return;
    const key = rowKey(target);
    busyKeys.add(key);
    try {
      const response = await client.decommissionTarget({
        nodeId: target.nodeId,
        targetId: target.targetId,
      });
      actionMessages = { ...actionMessages, [key]: response.message };
      if (response.ok) onRefresh();
    } catch (error) {
      actionMessages = {
        ...actionMessages,
        [key]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      busyKeys.delete(key);
      confirmingRemove.delete(key);
    }
  }

  /** Opens the embedded `AddTargetWizard` in Edit mode (issue #476) — see that component's own doc comment for what "prefilled" means here. */
  function openEdit(target: TargetListEntry): void {
    editingTarget = { nodeId: target.nodeId, targetId: target.targetId, label: target.label };
    editWizardOpen = true;
  }

  function closeEditWizard(): void {
    editWizardOpen = false;
    editingTarget = undefined;
  }

  /** The edit's replacement target is now paired — refresh so the list reflects the swap (the old target is already gone from a prior `decommissionTarget` call inside the wizard itself). */
  function handleEditProvisioned(): void {
    onRefresh();
  }
</script>

<section class="target-status-view" data-testid="target-status-view">
  <div class="header">
    <IconButton
      label="Refresh nodes and targets"
      onclick={onRefresh}
      dataTestId="target-status-refresh"
    >
      <Icon name="refresh" />
    </IconButton>
  </div>

  {#if error}
    <ErrorNotice message={error} retryable onRetry={onRefresh} />
  {/if}

  {#if loading}
    <p class="loading-state">
      <WovenLoader label="Checking node/target status" />
      Checking node/target status…
    </p>
  {:else if targets.length === 0}
    <EmptyState
      message="No nodes or targets connected yet. Add a target or connect a node from the sidebar to get started."
    />
  {:else}
    <ul class="target-rows">
      {#each targets as target (rowKey(target))}
        {@const state = healthState(target)}
        {@const icon = HEALTH_ICONS[state]}
        <li class="target-row" data-testid="target-status-row">
          <div
            data-testid={`target-status-row-${rowKey(target)}`}
            class="target-row-inner"
            data-health={state}
            class:focused={isFocused(target)}
          >
            <div class="target-heading">
              <strong>{target.label}</strong>
              <span class="kind-badge" data-kind={target.kind}>{target.kind}</span>
              <span class="node-id font-mono">{target.nodeId}</span>
              <span class="agent-health-badge" data-testid="agent-health-badge" data-state={state}
                ><StatusDot
                  tone={HEALTH_TONES[state]}
                  label={HEALTH_LABELS[state]}
                  size="sm"
                />{#if icon}<Icon name={icon} />{/if}{HEALTH_LABELS[state]}</span
              >
            </div>

            {#if target.health}
              {@const health = target.health}
              <div class="meters">
                <div class="meter-row">
                  <span class="meter-label">CPU</span>
                  <div class="meter" data-testid="cpu-meter">
                    <div
                      class="meter-fill thread-draw-fill"
                      data-level={meterLevel(health.cpuPercent)}
                      style={`--thread-draw-progress: ${Math.min(100, health.cpuPercent)}%`}
                    ></div>
                  </div>
                  <span class="meter-value">{Math.round(health.cpuPercent)}%</span>
                </div>
                <div class="meter-row">
                  <span class="meter-label">RAM</span>
                  <div class="meter" data-testid="mem-meter">
                    <div
                      class="meter-fill thread-draw-fill"
                      data-level={meterLevel(health.memPercent)}
                      style={`--thread-draw-progress: ${Math.min(100, health.memPercent)}%`}
                    ></div>
                  </div>
                  <span class="meter-value"
                    >{Math.round(health.memPercent)}% ({formatBytes(health.memUsedBytes)} / {formatBytes(
                      health.memTotalBytes,
                    )})</span
                  >
                </div>
                <div class="meter-row">
                  <span class="meter-label">Disk</span>
                  <div class="meter" data-testid="disk-meter">
                    <div
                      class="meter-fill thread-draw-fill"
                      data-level={meterLevel(health.diskPercent)}
                      style={`--thread-draw-progress: ${Math.min(100, health.diskPercent)}%`}
                    ></div>
                  </div>
                  <span class="meter-value"
                    >{Math.round(health.diskPercent)}% ({formatBytes(health.diskUsedBytes)} / {formatBytes(
                      health.diskTotalBytes,
                    )})</span
                  >
                </div>
              </div>
              <span class="sampled-at">Updated {formatSampledAt(health)}</span>
            {:else}
              <p class="no-data">No data yet.</p>
            {/if}

            {#if client}
              <div class="target-actions" data-testid="target-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  onclick={reconnect}
                  dataTestId={`target-action-reconnect-${rowKey(target)}`}
                >
                  Reconnect
                </Button>
                {#if target.kind === 'ssh'}
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busyKeys.has(rowKey(target))}
                    disabled={busyKeys.has(rowKey(target))}
                    onclick={() => runUpdate(target)}
                    dataTestId={`target-action-update-${rowKey(target)}`}
                  >
                    Update
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyKeys.has(rowKey(target))}
                    onclick={() => openEdit(target)}
                    dataTestId={`target-action-edit-${rowKey(target)}`}
                  >
                    Edit
                  </Button>
                  {#if confirmingRemove.has(rowKey(target))}
                    <span
                      class="remove-confirm"
                      data-testid={`target-action-remove-confirmbar-${rowKey(target)}`}
                    >
                      Remove this target?
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyKeys.has(rowKey(target))}
                        onclick={() => cancelRemove(target)}
                        dataTestId={`target-action-remove-cancel-${rowKey(target)}`}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={busyKeys.has(rowKey(target))}
                        onclick={() => confirmRemove(target)}
                        dataTestId={`target-action-remove-confirm-${rowKey(target)}`}
                      >
                        Remove
                      </Button>
                    </span>
                  {:else}
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busyKeys.has(rowKey(target))}
                      onclick={() => startRemove(target)}
                      dataTestId={`target-action-remove-${rowKey(target)}`}
                    >
                      Remove
                    </Button>
                  {/if}
                {/if}
              </div>
              {#if actionMessages[rowKey(target)]}
                <p class="action-message" data-testid={`target-action-message-${rowKey(target)}`}>
                  {actionMessages[rowKey(target)]}
                </p>
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if client}
  <AddTargetWizard
    open={editWizardOpen}
    {client}
    editing={editingTarget}
    onClose={closeEditWizard}
    onProvisioned={handleEditProvisioned}
  />
{/if}

<style>
  .target-status-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .header {
    display: flex;
    justify-content: flex-end;
  }

  .loading-state {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text-secondary);
  }

  .no-data {
    opacity: 0.6;
    font-size: var(--text-small-size);
    margin: 0;
  }

  .target-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .target-row {
    display: contents;
  }

  /* Raised elevation tier (redesign brief §3), plus a quiet left-edge
     stripe keyed by `healthState` — the same "stripe, not a tinted card"
     language `AttentionInbox` uses, so both attention surfaces read as
     one family. */
  .target-row-inner {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    border-left-width: var(--space-2xs);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-sm);
    transition:
      border-color var(--duration-fast) var(--ease-beat),
      box-shadow var(--duration-fast) var(--ease-beat);
  }

  .target-row-inner[data-health='healthy'] {
    border-left-color: var(--color-success);
  }

  .target-row-inner[data-health='overloaded'] {
    border-left-color: var(--color-warning);
  }

  .target-row-inner[data-health='unreachable'],
  .target-row-inner[data-health='node-offline'] {
    border-left-color: var(--color-danger);
  }

  .target-row-inner[data-health='no-data'] {
    border-left-color: var(--color-border-strong);
  }

  .target-row-inner.focused {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-accent);
  }

  .target-heading {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-xs);
  }

  .kind-badge {
    text-transform: uppercase;
    letter-spacing: 0.02em;
    font-size: var(--text-small-size);
    font-weight: 600;
    padding: var(--space-3xs) var(--space-xs);
    border-radius: var(--radius-full);
    background: var(--color-fill);
  }

  .node-id {
    font-size: var(--text-small-size);
    opacity: 0.7;
  }

  /* Health/status badge (redesign brief §6, issue #436): a `StatusDot`
     alongside its own text, both legibly larger than the previous
     0.7rem — color-by-state stays on the badge itself, so the dot
     reinforces rather than replaces the accessible text label. */
  .agent-health-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    margin-left: auto;
    font-size: var(--text-small-size);
    font-weight: 600;
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-full);
    background: var(--color-fill);
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .agent-health-badge[data-state='healthy'] {
    color: var(--color-success);
    background: var(--color-success-subtle);
  }

  .agent-health-badge[data-state='overloaded'] {
    color: var(--color-warning);
    background: var(--color-warning-subtle);
  }

  .agent-health-badge[data-state='unreachable'],
  .agent-health-badge[data-state='node-offline'] {
    color: var(--color-danger);
    background: var(--color-danger-subtle);
  }

  .meters {
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
  }

  .meter-row {
    display: grid;
    grid-template-columns: var(--space-3xl) 1fr auto;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--text-small-size);
  }

  .meter-label {
    opacity: 0.7;
  }

  .meter {
    height: var(--space-xs);
    border-radius: var(--radius-full);
    background: var(--color-fill);
    overflow: hidden;
  }

  /* thread-draw-fill (redesign brief §2, `$lib/styles/motion.css`): the
     fill spans the full track and reveals only its `--thread-draw-progress`
     share via `clip-path`, replacing the previous plain `width` transition
     — with `motion.css`'s own reduced-motion fallback applying for free. */
  .meter-fill {
    width: 100%;
    height: 100%;
    border-radius: var(--radius-full);
    background: var(--color-accent);
  }

  .meter-fill[data-level='elevated'] {
    background: var(--color-warning);
  }

  .meter-fill[data-level='high'] {
    background: var(--color-danger);
  }

  .meter-value {
    white-space: nowrap;
    opacity: 0.8;
  }

  .sampled-at {
    align-self: flex-end;
    font-size: var(--text-small-size);
    opacity: 0.6;
  }

  /* Connection management actions (redesign v2 §3.3; issue #476). */
  .target-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-xs);
    margin-top: var(--space-2xs);
  }

  .remove-confirm {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .action-message {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }
</style>
