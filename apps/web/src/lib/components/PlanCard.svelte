<script lang="ts">
  /**
   * The inline plan render (SPEC.md §7.24 "Plans", issue #143). ACP replaces
   * the whole plan entry list on every `plan_update` — never diffed
   * client-side — so this component just renders `plan` wholesale, at the
   * point in the transcript it was emitted. Shimmers while the plan's still
   * being worked (any entry not yet `completed`) and settles once every
   * entry is `completed`; collapsible, remembering collapse state for the
   * session (the caller owns that state — see `collapsed`/`onToggle` — so a
   * "remembers during the session" store lives once, in the transcript view,
   * not duplicated per card). The persistent per-session sidebar view of the
   * same data is a separate v2 issue (§12); this is the inline card only.
   *
   * Warp Deck restyle (docs/design/redesign.md §3/§6, issue #432): adopts
   * the elevation ladder's "raised" tier by name (the brief's table lists
   * `PlanCard` directly). The shimmer keeps its existing `plan-shimmer`
   * testid and behavior but is hand-styled as a small `thread-draw` ring
   * (the same traveling-`stroke-dashoffset` technique `StatusDot` uses for
   * its `pulse` state) instead of a plain opacity blink, so an in-progress
   * plan reads as part of the same motion language as the rest of the app.
   * A single un-staggered `beat-in` plays once on mount (mirroring
   * `MessageItem`/`ToolCallRow`).
   */
  import type { AcpPlanEntry } from '@loombox/providers-core';
  import CopyButton from './CopyButton.svelte';
  import StatusDot from './ui/StatusDot.svelte';

  interface Props {
    entries: AcpPlanEntry[];
    collapsed: boolean;
    onToggle: () => void;
  }

  const { entries, collapsed, onToggle }: Props = $props();

  const active = $derived(entries.some((entry) => entry.status !== 'completed'));
  const completedCount = $derived(entries.filter((entry) => entry.status === 'completed').length);
  const copyText = $derived(
    entries.map((entry) => `[${entry.status}] ${entry.content}`).join('\n'),
  );
</script>

<div class="plan-card" class:active data-testid="plan-card">
  <button
    type="button"
    class="plan-header"
    onclick={onToggle}
    aria-expanded={!collapsed}
    aria-label={collapsed ? 'Expand plan' : 'Collapse plan'}
  >
    <span class="chevron">{collapsed ? '▸' : '▾'}</span>
    <span class="title">Plan</span>
    <span class="progress">{completedCount}/{entries.length}</span>
    {#if active}
      <span class="shimmer" data-testid="plan-shimmer">
        <StatusDot tone="info" pulse label="Plan in progress" />
      </span>
    {/if}
  </button>

  {#if !collapsed}
    <ol class="plan-entries">
      {#each entries as entry, index (index)}
        <li class={entry.status}>
          <span class="checkbox" aria-hidden="true">{entry.status === 'completed' ? '☑' : '☐'}</span
          >
          <span class="content">{entry.content}</span>
        </li>
      {/each}
    </ol>
    <div class="plan-actions">
      <CopyButton text={copyText} label="Copy plan" />
    </div>
  {/if}
</div>

<style>
  /* raised tier (elevation ladder §3): PlanCard is named directly in the
     ladder's table. */
  .plan-card {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    font-size: 0.9rem;
    /* Single un-staggered beat-in (redesign brief §2), mount-once same as
       MessageItem/ToolCallRow. */
    animation: beat-in var(--duration-base) var(--ease-beat) both;
  }

  @keyframes beat-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .plan-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm) 0.7rem;
    background: var(--color-fill-subtle);
    border: none;
    cursor: pointer;
    color: inherit;
    text-align: left;
  }

  .title {
    font-weight: 600;
    flex: 1;
  }

  .progress {
    opacity: 0.6;
    font-size: var(--text-small-size);
  }

  .shimmer {
    display: inline-flex;
    flex-shrink: 0;
  }

  .plan-entries {
    list-style: none;
    margin: 0;
    padding: var(--space-xs) 0.7rem;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .plan-entries li {
    display: flex;
    gap: var(--space-xs);
    align-items: baseline;
  }

  .plan-entries li .checkbox {
    color: var(--color-text-muted);
  }

  .plan-entries li.completed .checkbox {
    color: var(--color-success);
  }

  .plan-entries li.completed .content {
    opacity: 0.55;
    text-decoration: line-through;
  }

  .plan-entries li.in_progress .content {
    font-weight: 600;
  }

  .plan-actions {
    display: flex;
    justify-content: flex-end;
    padding: 0 var(--space-sm) var(--space-xs);
  }

  /* Touch-optimized plan controls (SPEC.md §7.3, issue #133): the plan
     header (its only tap target — the individual entries below are a
     read-only, agent-driven checklist, not user-interactive in v1) grows to
     a larger hit target on a coarse (touch) pointer. */
  @media (pointer: coarse) {
    .plan-header {
      min-height: 2.75rem;
      padding: 0.65rem 0.9rem;
    }
  }
</style>
