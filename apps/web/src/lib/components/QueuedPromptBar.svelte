<script lang="ts">
  /**
   * The transcript-adjacent list of the composer's own not-yet-sent prompts
   * (SPEC.md §7.24's mid-turn composer state bullet, issue #128; SPEC §7.3's
   * offline queueing, issue #130). Renders each `QueuedPrompt` as its own
   * "queued" row, oldest first, styled deliberately close to `MessageItem`'s
   * user-turn look (so it reads as "this message, about to be sent") but
   * visibly muted and badged "Queued" — distinct both from a normal sent
   * message and from the separate `PermissionQueueBar` Stop action (SPEC
   * §7.24: "This is distinct from the explicit Stop button").
   *
   * Deliberately outside the actual transcript reducer (`TranscriptState`):
   * `RelayClient.sendPrompt` never applies a queued prompt to
   * `transcriptFor` until it is actually flushed, so this is the only place
   * a queued prompt is visible until then.
   *
   * Design spec v5 §4: this used to mirror `MessageItem`'s pre-v3 "chat
   * bubble" geometry — right-aligned, capped at ~70ch — which was already
   * the one surviving artefact of a metaphor the rest of the transcript had
   * abandoned (`MessageItem` itself dropped its own bubble in redesign v3).
   * Now it mirrors what `MessageItem` actually looks like today instead:
   * the same full-width gutter-plus-content row, labelled "You" (a queued
   * prompt is always the user's own next turn) in the same visible
   * `--text-caption-size` role label every other row carries. The dashed
   * accent border + muted opacity + "Queued" badge on `.content` are what's
   * left to say "not sent yet" — a state cue, not a layout one. A single
   * un-staggered `beat-in` still plays once per row on mount, same as
   * `MessageItem`/`PlanCard`.
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
        <div class="gutter">
          <span class="role-label">You</span>
        </div>
        <div class="content">
          <span class="badge">Queued</span>
          <p class="text">{prompt.text}</p>
        </div>
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
    gap: var(--space-sm);
  }

  /* Same full-width gutter-plus-content shape as MessageItem (design spec
     v5 §4) — never right-aligned, never width-capped as a bubble. */
  .queued-item {
    display: flex;
    align-items: flex-start;
    width: 100%;
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

  .gutter {
    flex: 0 0 var(--gutter);
    width: var(--gutter);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-3xs);
    padding-top: var(--space-sm);
    padding-right: var(--space-sm);
  }

  /* Same as `MessageItem`'s and the composer's: the word is the mark, in the
     accent that says "yours", right-aligned onto the shared column. The 4px
     accent dot that used to sit above it is gone with the rest of them. */
  .role-label {
    font-size: var(--text-caption-size);
    line-height: var(--text-caption-line);
    letter-spacing: var(--text-caption-tracking);
    font-weight: var(--text-caption-weight);
    text-transform: uppercase;
    color: var(--color-accent);
    text-align: right;
    white-space: nowrap;
  }

  /* What's left to say "not sent yet" once the bubble geometry is gone: a
     dashed accent ring + muted opacity + the "Queued" badge, on the
     content box only — a state cue, not a layout one. */
  .content {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-lg);
    border: 1px dashed var(--color-accent);
    background: var(--color-accent-subtle);
    opacity: 0.8;
  }

  .badge {
    flex-shrink: 0;
    font-size: var(--text-caption-size);
    line-height: var(--text-caption-line);
    font-weight: var(--text-caption-weight);
    text-transform: uppercase;
    letter-spacing: var(--text-caption-tracking);
    color: var(--color-accent);
  }

  .text {
    flex: 1;
    min-width: 0;
    margin: 0;
    white-space: pre-wrap;
  }

  /* Below `--bp-mobile` the role column collapses and the word moves above
     the turn — see `MessageItem`'s own copy of this block for the
     measurement and the reasoning. Every surface sharing this column moves at
     the same breakpoint or the timeline's one rule becomes several. */
  @media (max-width: 479px) {
    .queued-item {
      flex-direction: column;
      align-items: stretch;
    }

    .gutter {
      flex: 0 0 auto;
      width: auto;
      align-items: flex-start;
      padding-right: 0;
      padding-bottom: 0;
    }
  }
</style>
