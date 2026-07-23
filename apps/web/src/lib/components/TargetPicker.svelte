<script lang="ts">
  /**
   * Picks a target/node to run a new session on (SPEC §7.1's "choosing a
   * node, a target"; issue #385), from `RelayClient.listTargets()`'s
   * account-scoped `TargetListEntry[]` (issue #383). Purely presentational —
   * `NewSessionDialog.svelte` owns fetching, loading/error state, and the
   * richer "no nodes connected yet" empty-state CTA; this component only
   * renders whatever `targets` it's given and reports a pick.
   */
  import type { TargetListEntry } from '$lib/relay-client';

  interface Props {
    targets: TargetListEntry[];
    value: string | undefined;
    onChange: (targetId: string) => void;
  }

  const { targets, value, onChange }: Props = $props();
</script>

<div class="target-picker" role="radiogroup" aria-label="Target" data-testid="target-picker">
  {#if targets.length === 0}
    <p class="empty">No targets available.</p>
  {:else}
    {#each targets as target (target.nodeId + ':' + target.targetId)}
      <button
        type="button"
        class="target-option"
        class:selected={value === target.targetId}
        class:unreachable={!target.reachable}
        role="radio"
        aria-checked={value === target.targetId}
        disabled={!target.reachable}
        onclick={() => onChange(target.targetId)}
        data-testid="target-option"
        data-target-id={target.targetId}
      >
        <span class="label">{target.label}</span>
        <span class="meta">
          <span class="kind-badge" data-kind={target.kind}>{target.kind}</span>
          <span class="node-id font-mono">{target.nodeId}</span>
          {#if !target.reachable}
            <span class="unreachable-badge">offline</span>
          {/if}
        </span>
      </button>
    {/each}
  {/if}
</div>

<style>
  .target-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    max-height: 14rem;
    overflow-y: auto;
  }

  .empty {
    margin: 0;
    opacity: 0.6;
    font-size: var(--text-small-size);
  }

  .target-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-xs) var(--space-sm);
    text-align: left;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface-raised);
    color: inherit;
    cursor: pointer;
  }

  .target-option:hover:not(:disabled),
  .target-option:focus-visible {
    border-color: var(--color-accent);
  }

  .target-option:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .target-option.selected {
    border-color: var(--color-accent);
    background: var(--color-accent-subtle);
  }

  .target-option:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .label {
    font-weight: 500;
  }

  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-xs);
    font-size: 0.7rem;
    opacity: 0.7;
    min-width: 0;
  }

  .node-id {
    display: inline-block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 9rem;
    vertical-align: bottom;
  }

  .kind-badge {
    text-transform: uppercase;
    letter-spacing: 0.02em;
    padding: var(--space-3xs) var(--space-xs);
    border-radius: var(--radius-full);
    background: var(--color-fill);
  }

  .unreachable-badge {
    color: var(--color-danger);
  }
</style>
