<script lang="ts">
  /**
   * The cross-project attention inbox (SPEC.md §7.13, issues #167/#168/#169):
   * one list of every session-level item across every project/session that
   * needs the user now — a session's actionable FIFO-head permission
   * request, or a session whose live status is `awaiting_input` — sorted
   * oldest-waiting first (`RelayClient.attentionInbox()`'s own sort, not
   * re-sorted here).
   *
   * A permission item is actionable inline (issue #168): its approve/deny
   * buttons reuse `PermissionCard`, the exact same component the session's
   * own `PermissionQueueBar` renders, wired to the same `onResolve` callback
   * a caller backs with `RelayClient.resolvePermission` — approving here and
   * approving from the session's own view are the same write to the same
   * queue store, not two independent "resolve" paths that could drift
   * (issue #169's single-source-of-truth requirement). Every item also has
   * an Open action (`onOpenSession`) that jumps to its originating session.
   */
  import type { AcpPermissionOption } from '@loombox/providers-core';
  import type { AttentionInboxItem } from '../relay-client';
  import PermissionCard from './PermissionCard.svelte';

  interface Props {
    items: AttentionInboxItem[];
    onResolve: (sessionId: string, requestId: string, option: AcpPermissionOption) => void;
    onOpenSession: (sessionId: string) => void;
  }

  const { items, onResolve, onOpenSession }: Props = $props();

  function itemKey(item: AttentionInboxItem): string {
    return item.kind === 'permission' && item.permission
      ? `permission:${item.permission.requestId}`
      : `awaiting_input:${item.sessionId}`;
  }

  function needLabel(item: AttentionInboxItem): string {
    if (item.kind === 'permission') {
      const toolCall = item.permission?.toolCall;
      return `Needs approval: ${toolCall?.title ?? toolCall?.id ?? 'a tool call'}`;
    }
    return 'Waiting for your reply';
  }
</script>

<div class="attention-inbox" data-testid="attention-inbox">
  {#if items.length === 0}
    <p class="empty">Nothing needs your attention.</p>
  {:else}
    <ul>
      {#each items as item (itemKey(item))}
        <li class="item" data-kind={item.kind} data-testid="attention-inbox-item">
          <div class="item-header">
            <button
              type="button"
              class="open"
              onclick={() => onOpenSession(item.sessionId)}
              data-testid="attention-inbox-open"
            >
              <strong>{item.sessionTitle}</strong>
              <small>{item.projectPath}</small>
            </button>
            <span class="need">{needLabel(item)}</span>
          </div>
          {#if item.kind === 'permission' && item.permission}
            {@const request = item.permission}
            <PermissionCard
              {request}
              actionable={true}
              onResolve={(option) => onResolve(item.sessionId, request.requestId, option)}
            />
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .attention-inbox {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .empty {
    opacity: 0.6;
    margin: 0;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .item {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem;
    border: 1px solid rgba(127, 127, 127, 0.25);
    border-radius: 0.5rem;
  }

  .item[data-kind='awaiting_input'] {
    border-color: rgba(79, 70, 229, 0.4);
  }

  .item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .open {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
  }

  .open small {
    opacity: 0.6;
  }

  .need {
    font-size: 0.75rem;
    opacity: 0.75;
  }
</style>
