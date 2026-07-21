<script lang="ts">
  /**
   * The transcript-adjacent list of the composer's own not-yet-sent prompts
   * (SPEC.md §7.24's mid-turn composer state bullet, issue #128; SPEC §7.3's
   * offline queueing, issue #130). Renders each `QueuedPrompt` as its own
   * "queued" row, oldest first, styled deliberately close to `MessageItem`'s
   * user-message look (so it reads as "this message, about to be sent") but
   * visibly muted and badged "Queued" — distinct both from a normal sent
   * message and from the separate `PermissionQueueBar` Stop action (SPEC
   * §7.24: "This is distinct from the explicit Stop button").
   *
   * Deliberately outside the actual transcript reducer (`TranscriptState`):
   * `RelayClient.sendPrompt` never applies a queued prompt to
   * `transcriptFor` until it is actually flushed, so this is the only place
   * a queued prompt is visible until then.
   */
  import type { QueuedPrompt } from '$lib/outbox';

  interface Props {
    prompts: QueuedPrompt[];
  }

  const { prompts }: Props = $props();
</script>

{#if prompts.length > 0}
  <ul class="queued-prompt-bar" data-testid="queued-prompt-bar">
    {#each prompts as prompt (prompt.id)}
      <li class="queued-item" data-testid="queued-prompt">
        <span class="badge">Queued</span>
        <p class="text">{prompt.text}</p>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .queued-prompt-bar {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .queued-item {
    align-self: flex-end;
    display: flex;
    align-items: flex-start;
    gap: var(--space-xs);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-lg);
    border: 1px dashed var(--color-accent);
    background: var(--color-accent-subtle);
    opacity: 0.75;
  }

  .badge {
    flex-shrink: 0;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.75;
    padding-top: var(--space-2xs);
  }

  .text {
    flex: 1;
    margin: 0;
    white-space: pre-wrap;
  }
</style>
