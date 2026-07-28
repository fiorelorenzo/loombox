<script lang="ts">
  /**
   * Picks a target/node to run a new session on (SPEC §7.1's "choosing a
   * node, a target"; issue #385), from `RelayClient.listTargets()`'s
   * account-scoped `TargetListEntry[]` (issue #383). Purely presentational —
   * `NewSessionDialog.svelte` owns fetching, loading/error state, and the
   * richer "no nodes connected yet" empty-state CTA; this component only
   * renders whatever `targets` it's given and reports a pick.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §3/§4,
   * issue #431): rows sit at the `raised` elevation tier (session/target
   * cards' documented tier), selection reads as a 2px accent left-bar +
   * subtle tint rather than a solid accent border (accent-for-meaning),
   * and reachability is now signaled with a shared `StatusDot` alongside
   * the existing "offline" text badge (kept, so this component's own
   * `getByText('offline')` test assertion is untouched).
   *
   * Deck migration (redesign v2 §2 "Consistency sweep", issue #464): the
   * "no targets available" fallback now reads through the shared
   * `EmptyState` primitive instead of a hand-styled `<p>`.
   */
  import type { TargetListEntry } from '$lib/relay-client';
  import EmptyState from './ui/EmptyState.svelte';
  import StatusDot from './ui/StatusDot.svelte';

  interface Props {
    targets: TargetListEntry[];
    value: string | undefined;
    onChange: (targetId: string) => void;
  }

  const { targets, value, onChange }: Props = $props();
</script>

<div class="target-picker" role="radiogroup" aria-label="Target" data-testid="target-picker">
  {#if targets.length === 0}
    <EmptyState message="No targets available." />
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
        <StatusDot
          tone={target.reachable ? 'success' : 'danger'}
          label={target.reachable ? 'Reachable' : 'Unreachable'}
          size="sm"
        />
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

  /* `raised` elevation tier (redesign brief §3): target cards. */
  .target-option {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-xs) var(--space-sm);
    text-align: left;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    border-left: 2px solid transparent;
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-sm);
    color: inherit;
    cursor: pointer;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .target-option:not(:disabled):active {
    transform: scale(0.995);
  }

  .target-option:hover:not(:disabled) {
    background: var(--color-fill-subtle);
  }

  .target-option:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* Selected: a 2px accent left-bar + subtle tint, never a solid accent
     border/fill (redesign brief §4's row convention: accent reserved for
     meaning, echoing a highlighted thread on a warp). */
  .target-option.selected {
    border-left-color: var(--color-accent);
    background: var(--color-accent-subtle);
  }

  .target-option:disabled {
    opacity: 0.55;
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
    margin-left: auto;
    color: var(--color-text-secondary);
    font-size: var(--text-caption-size);
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
