<script lang="ts">
  /**
   * The revival boundary row (issue #706/#912): renders a
   * `TranscriptRevivalItem` — the client-side reduction of a `'starting'`
   * `session_status` event carrying a `reason`, which only ever happens
   * for `NodeDaemon.reviveSessionInternal` (a session reloaded
   * `'disconnected'` after a node restart, then sent a fresh prompt). The
   * persisted transcript above this row is unaffected by the restart (it
   * lives in the relay's own resync ring, independent of which agent
   * process is behind the session) — what changed is that a brand-new
   * agent process is now the one answering, with none of the old
   * process's own understanding of the conversation above. Rendered
   * inline, at the exact point in the timeline where that new process
   * starts, so its first reply below this row is never mistaken for a
   * continuation of the turns above it — the same "an absent thing says
   * so" discipline issues #204/#249 already established, not papered
   * over here either.
   *
   * Info-tinted (`--color-info`), not warning/danger: nothing failed —
   * `prompt_inject_result`'s `outcome: 'error'` is what surfaces an actual
   * failure (`RelayClient.promptInjectErrorFor`) — this is a permanent,
   * honest record of a normal (if noteworthy) transition, closer to
   * `TranscriptGap`'s own "quiet inline row" reading than `ErrorNotice`'s.
   */
  import type { TranscriptRevivalItem } from '@loombox/providers-core/browser';
  import Icon from './icons/Icon.svelte';

  interface Props {
    item: TranscriptRevivalItem;
  }

  const { item }: Props = $props();
</script>

<div class="transcript-revival" role="status" data-testid="transcript-revival">
  <Icon name="refresh" size="16" />
  <span class="transcript-revival-text">{item.reason}</span>
</div>

<style>
  .transcript-revival {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    width: 100%;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-info-subtle);
    border: 1px solid var(--color-info);
    color: var(--color-info);
    animation: beat-in var(--duration-base) var(--ease-beat) both;
  }

  .transcript-revival-text {
    font-size: var(--text-small-size);
    line-height: var(--text-small-line);
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
</style>
