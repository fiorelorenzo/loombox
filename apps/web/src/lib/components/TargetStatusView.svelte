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
   */
  import type { TargetHealth, TargetListEntry } from '$lib/relay-client';
  import WovenLoader from './WovenLoader.svelte';

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
    onClose: () => void;
    /** A specific node/target to highlight (issue #269's "a stalled session's view links back to this status view for its target") — e.g. `+page.svelte` sets this from the session row the user clicked through from. */
    focusTarget?: FocusTarget;
  }

  const { targets, loading, error, onRefresh, onClose, focusTarget }: Props = $props();

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
</script>

<section class="target-status-view" data-testid="target-status-view">
  <div class="header">
    <h2>Nodes &amp; targets</h2>
    <div class="header-actions">
      <button type="button" onclick={onRefresh} data-testid="target-status-refresh">Refresh</button>
      <button type="button" onclick={onClose} data-testid="target-status-close">Close</button>
    </div>
  </div>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="loading-state">
      <WovenLoader label="Checking node/target status" />
      Checking node/target status…
    </p>
  {:else if targets.length === 0}
    <p class="empty">No nodes/targets connected yet.</p>
  {:else}
    <ul class="target-rows">
      {#each targets as target (rowKey(target))}
        {@const state = healthState(target)}
        <li class="target-row" data-testid="target-status-row">
          <div
            data-testid={`target-status-row-${rowKey(target)}`}
            class="target-row-inner"
            class:focused={isFocused(target)}
          >
            <div class="target-heading">
              <strong>{target.label}</strong>
              <span class="kind-badge" data-kind={target.kind}>{target.kind}</span>
              <span class="node-id font-mono">{target.nodeId}</span>
              <span class="agent-health-badge" data-testid="agent-health-badge" data-state={state}>
                {HEALTH_LABELS[state]}
              </span>
            </div>

            {#if target.health}
              {@const health = target.health}
              <div class="meters">
                <div class="meter-row">
                  <span class="meter-label">CPU</span>
                  <div class="meter" data-testid="cpu-meter">
                    <div
                      class="meter-fill"
                      data-level={meterLevel(health.cpuPercent)}
                      style={`width: ${Math.min(100, health.cpuPercent)}%`}
                    ></div>
                  </div>
                  <span class="meter-value">{Math.round(health.cpuPercent)}%</span>
                </div>
                <div class="meter-row">
                  <span class="meter-label">RAM</span>
                  <div class="meter" data-testid="mem-meter">
                    <div
                      class="meter-fill"
                      data-level={meterLevel(health.memPercent)}
                      style={`width: ${Math.min(100, health.memPercent)}%`}
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
                      class="meter-fill"
                      data-level={meterLevel(health.diskPercent)}
                      style={`width: ${Math.min(100, health.diskPercent)}%`}
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
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .target-status-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
  }

  .header h2 {
    margin: 0;
  }

  .header-actions {
    display: flex;
    gap: var(--space-xs);
  }

  .loading-state {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    opacity: 0.8;
  }

  .empty,
  .no-data {
    opacity: 0.6;
    font-size: var(--text-small-size);
    margin: 0;
  }

  .error {
    color: var(--color-danger);
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

  .target-row-inner {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface-raised);
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
    font-size: 0.7rem;
    padding: var(--space-3xs) var(--space-xs);
    border-radius: var(--radius-full);
    background: var(--color-fill);
  }

  .node-id {
    font-size: 0.7rem;
    opacity: 0.7;
  }

  .agent-health-badge {
    margin-left: auto;
    font-size: 0.7rem;
    padding: var(--space-3xs) var(--space-xs);
    border-radius: var(--radius-full);
    background: var(--color-fill);
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
    grid-template-columns: 2.5rem 1fr auto;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--text-small-size);
  }

  .meter-label {
    opacity: 0.7;
  }

  .meter {
    height: 0.4rem;
    border-radius: var(--radius-full);
    background: var(--color-fill);
    overflow: hidden;
  }

  .meter-fill {
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
    font-size: 0.7rem;
    opacity: 0.6;
  }
</style>
