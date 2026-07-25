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
   *
   * Warp Deck restyle (docs/design/redesign.md §4/§6, issue #439): "a
   * `state=\"queued\"` styling of the same bubble treatment" — mirrors
   * `MessageItem`'s real user-bubble geometry (right-aligned, capped at
   * ~70ch) rather than an independently-maintained look-alike, kept
   * visually distinct only by the dashed accent ring + muted opacity + the
   * "Queued" badge. A single un-staggered `beat-in` plays once per row on
   * mount, same as `MessageItem`/`PlanCard`.
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

  /* Mirrors MessageItem's own user-bubble geometry (redesign brief §6):
     right-aligned, capped at ~70ch, same radius/padding rhythm — kept
     visually distinct only by the dashed accent ring, muted opacity, and
     the "Queued" badge. */
  .queued-item {
    align-self: flex-end;
    max-width: min(70ch, 100%);
    display: flex;
    align-items: flex-start;
    gap: var(--space-xs);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-lg);
    border: 1px dashed var(--color-accent);
    background: var(--color-accent-subtle);
    opacity: 0.8;
    animation: beat-in var(--duration-base) var(--ease-beat) both;
  }

  @keyframes beat-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 0.8;
      transform: translateY(0);
    }
  }

  .badge {
    flex-shrink: 0;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-accent);
    padding-top: var(--space-3xs);
  }

  .text {
    flex: 1;
    margin: 0;
    white-space: pre-wrap;
  }
</style>
