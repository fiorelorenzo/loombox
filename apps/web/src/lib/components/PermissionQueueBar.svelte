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
  import type { AcpPermissionOption, PermissionQueueState } from '@loombox/providers-core/browser';
  import { headPermissionRequest, listPermissionRequests } from '@loombox/providers-core/browser';
  import PermissionCard from './PermissionCard.svelte';
  import Button from './ui/Button.svelte';
  import StatusDot from './ui/StatusDot.svelte';

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
      <span class="queue-count">
        <StatusDot
          tone="warning"
          pulse={pending.length > 1}
          label="Permission requests pending"
          size="sm"
        />
        <span class="font-mono">{pending.length}</span> pending
      </span>
      <Button variant="danger" size="sm" onclick={onStop}>Stop</Button>
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

  /* "N more waiting" glanceable at a glance (docs/design/redesign.md, issue
     #433's brief): a quiet pill instead of dimmed inline text, with a
     StatusDot carrying the same pending/queued meaning `PermissionCard`
     itself uses — the queue-count text stays byte-for-byte the same string
     the existing test asserts on ("N pending"), just given a more
     glanceable frame. */
  .queue-meta {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .queue-count {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    padding: var(--space-2xs) var(--space-md);
    border-radius: var(--radius-full);
    background: var(--color-warning-subtle);
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
    font-weight: 600;
    line-height: 1;
  }
</style>
