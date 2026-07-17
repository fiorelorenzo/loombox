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
  }

  const { sessionId, queue, onResolve, onStop }: Props = $props();

  const pending = $derived(listPermissionRequests(queue, sessionId));
  const head = $derived(headPermissionRequest(queue, sessionId));
</script>

{#if head}
  <div class="permission-queue-bar" data-testid="permission-queue-bar">
    <div class="queue-meta">
      <span>{pending.length} pending</span>
      <button type="button" class="stop" onclick={onStop}>Stop</button>
    </div>
    <PermissionCard
      request={head}
      actionable={true}
      onResolve={(option) => onResolve(head.requestId, option)}
    />
  </div>
{/if}

<style>
  .permission-queue-bar {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .queue-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.75rem;
    opacity: 0.7;
  }

  .stop {
    border: 1px solid #dc2626;
    color: #dc2626;
    background: transparent;
    border-radius: 0.3rem;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
    font-size: 0.75rem;
  }
</style>
