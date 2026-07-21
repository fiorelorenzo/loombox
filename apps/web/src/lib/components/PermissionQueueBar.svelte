<script lang="ts">
  /**
   * The composer-site permission queue orchestrator (SPEC.md §7.24
   * "Tool-call permissions", issues #144/#146/#147): renders exactly one
   * focused card — the session's current FIFO head — never a blocking
   * modal, so a queue on one session never stops the user watching another.
   * This is also the "composer-site copy" the nested-visibility rule (issue
   * #146) requires to always be visible independent of any collapse state:
   * v1 has no nested tool-call groups to collapse yet (flat list only), so
   * this bar *is* that always-visible copy, trivially satisfying the rule
   * until subagent trees ship in v2 and a second, inline copy is added
   * alongside it.
   *
   * `Stop` (issue #147) resolves every open request for the session as
   * cancelled immediately, optimistically — `onStop` is expected to call
   * `RelayClient.cancelPermissionRequests`, so no card's spinner survives
   * past the press.
   */
  import type { AcpPermissionOption, PermissionQueueState } from '@loombox/providers-core';
  import { headPermissionRequest, listPermissionRequests } from '@loombox/providers-core';
  import PermissionCard from './PermissionCard.svelte';

  interface Props {
    sessionId: string;
    queue: PermissionQueueState;
    onResolve: (requestId: string, option: AcpPermissionOption) => void;
    onStop: () => void;
    /** SPEC.md §7.3 "Narrow-viewport permission footer" (issue #134) — forwarded to `PermissionCard`; also pins this bar to the bottom of its scroll container so it's always reachable without hunting for it below the fold. Defaults `false`. */
    narrow?: boolean;
  }

  const { sessionId, queue, onResolve, onStop, narrow = false }: Props = $props();

  const pending = $derived(listPermissionRequests(queue, sessionId));
  const head = $derived(headPermissionRequest(queue, sessionId));
</script>

{#if head}
  <div class="permission-queue-bar" class:narrow data-testid="permission-queue-bar">
    <div class="queue-meta">
      <span>{pending.length} pending</span>
      <button type="button" class="stop" onclick={onStop}>Stop</button>
    </div>
    <PermissionCard
      request={head}
      actionable={true}
      onResolve={(option) => onResolve(head.requestId, option)}
      {narrow}
    />
  </div>
{/if}

<style>
  .permission-queue-bar {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  /* Narrow-viewport permission footer (SPEC.md §7.3; issue #134): pinned to
     the bottom of the transcript's own scroll container so it stays
     reachable on a phone without the user hunting for it below the fold. */
  .permission-queue-bar.narrow {
    position: sticky;
    bottom: 0;
    padding-top: var(--space-xs);
    background: var(--color-surface);
  }

  .queue-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: var(--text-small-size);
    opacity: 0.7;
  }

  .stop {
    border: 1px solid var(--color-danger);
    color: var(--color-danger);
    background: transparent;
    border-radius: var(--radius-sm);
    padding: var(--space-3xs) var(--space-sm);
    cursor: pointer;
    font-size: var(--text-small-size);
  }

  /* Touch-optimized permission controls (SPEC.md §7.3, issue #133): a
     coarse (touch) pointer gets a larger Stop hit target. */
  @media (pointer: coarse) {
    .stop {
      min-height: 2.75rem;
      padding: 0.5rem 0.9rem;
      font-size: 0.9rem;
    }
  }
</style>
