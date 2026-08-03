<script lang="ts">
  /**
   * The shared status indicator for a tool-call header row (design spec
   * `2026-08-03-cockpit-v6-design.md` §3.4, issue #576 point 4 "status
   * belongs where the eye already is"). `GenericToolRow`, `BashWidget`,
   * `EditWriteWidget` and `TodoWidget` used to each hand-roll the same
   * `StatusDot` + visible label pair, and showed "Completed" exactly as
   * loudly as "Failed" — a row that finished cleanly and one that broke
   * carried identical visual weight. One component decides the rule now
   * instead of four copies quietly drifting apart:
   *
   * - `pending` / `in_progress` keep the visible label next to the dot —
   *   the call is still moving, so the word is signal.
   * - `completed` drops the visible label. The dot alone (tone `success`)
   *   is enough once a card has settled; "Completed" repeated on every
   *   card in a run of five was the noise the issue named. The accessible
   *   name does not move — `StatusDot`'s own `role="img"` `aria-label`
   *   still announces "Completed" to a screen reader, only the sighted,
   *   always-on caption goes.
   * - `failed` is the one state that must shout: the label stays visible,
   *   bold, `--color-danger`, on a `--color-danger-subtle` chip — the one
   *   piece of a settled tool-call row allowed to look alarmed, so a
   *   failure reads as louder than a success rather than equally quiet.
   */
  import type { AcpToolCallStatus } from '@loombox/providers-core/browser';
  import { TOOL_CALL_STATUS_LABELS, TOOL_CALL_STATUS_TONES } from '$lib/tool-widgets';
  import StatusDot from './ui/StatusDot.svelte';

  interface Props {
    status: AcpToolCallStatus | undefined;
  }

  const { status }: Props = $props();

  const tone = $derived(status ? TOOL_CALL_STATUS_TONES[status] : undefined);
  const label = $derived(status ? TOOL_CALL_STATUS_LABELS[status] : undefined);
</script>

{#if tone && label}
  <span
    class="tool-call-status"
    class:tool-call-status-failed={status === 'failed'}
    data-testid="tool-call-status"
  >
    <StatusDot {tone} {label} size="sm" />
    {#if status !== 'completed'}
      <span class="status-label" aria-hidden="true">{label}</span>
    {/if}
  </span>
{/if}

<style>
  .tool-call-status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    flex-shrink: 0;
  }

  .status-label {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
    font-weight: 400;
  }

  /* The one status allowed to shout (see the file doc comment): bold,
     danger-toned text on its own subtle chip, so a failed call in a run of
     otherwise-quiet completed ones is what actually draws the eye. */
  .tool-call-status-failed .status-label {
    color: var(--color-danger);
    font-weight: 700;
    background: var(--color-danger-subtle);
    padding: var(--space-3xs) var(--space-2xs);
    border-radius: var(--radius-sm);
  }
</style>
