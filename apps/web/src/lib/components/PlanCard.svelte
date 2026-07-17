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
   */
  import type { AcpPlanEntry } from '@loombox/providers-core';
  import CopyButton from './CopyButton.svelte';

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
    {#if active}<span class="shimmer" data-testid="plan-shimmer" aria-hidden="true"></span>{/if}
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
  .plan-card {
    border: 1px solid rgba(127, 127, 127, 0.25);
    border-radius: 0.5rem;
    overflow: hidden;
    font-size: 0.9rem;
  }

  .plan-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.7rem;
    background: rgba(127, 127, 127, 0.08);
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
    font-size: 0.8rem;
  }

  .shimmer {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }

  .plan-entries {
    list-style: none;
    margin: 0;
    padding: 0.4rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .plan-entries li {
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
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
    padding: 0 0.5rem 0.4rem;
  }
</style>
