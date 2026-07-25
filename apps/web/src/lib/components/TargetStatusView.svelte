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
   */
  import type { TargetHealth, TargetListEntry } from '$lib/relay-client';
  import WovenLoader from './WovenLoader.svelte';
  import StatusDot, { type StatusTone } from './ui/StatusDot.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';

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

  /** Maps `HealthState` onto the shared `StatusDot` tone vocabulary — the same four semantic colors this view's own badge already carries, just also driving the dot. */
  const HEALTH_TONES: Record<HealthState, StatusTone> = {
    'no-data': 'neutral',
    'node-offline': 'danger',
    unreachable: 'danger',
    overloaded: 'warning',
    healthy: 'success',
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
      <button
        type="button"
        class="header-btn"
        onclick={onRefresh}
        data-testid="target-status-refresh">Refresh</button
      >
      <button type="button" class="header-btn" onclick={onClose} data-testid="target-status-close"
        >Close</button
      >
    </div>
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
    <EmptyState message="No nodes/targets connected yet." />
  {:else}
    <ul class="target-rows">
      {#each targets as target (rowKey(target))}
        {@const state = healthState(target)}
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
                />{HEALTH_LABELS[state]}</span
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
    font-size: var(--text-title-size);
    line-height: var(--text-title-line);
    font-weight: var(--text-title-weight);
    color: var(--color-text-primary);
  }

  .header-actions {
    display: flex;
    gap: var(--space-xs);
  }

  /* Hand-styled to match `Button`'s secondary visual language (redesign
     brief §4) — kept as plain buttons, not the shared component, so the
     `target-status-refresh`/`target-status-close` `data-testid`s stay on
     the actual clickable element the tests query. */
  .header-btn {
    padding: var(--space-2xs) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border-strong);
    background: transparent;
    color: var(--color-text-primary);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .header-btn:hover {
    background: var(--color-fill-subtle);
  }

  /* tension-press (redesign brief §2). */
  .header-btn:active {
    background: var(--color-fill);
    transform: scale(0.98);
  }

  .header-btn:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
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
</style>
