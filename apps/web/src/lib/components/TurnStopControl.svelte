<script lang="ts">
  /**
   * The session-level turn Stop/interrupt control (SPEC.md §7.3
   * "Stop/interrupt any running agent turn with one tap ... distinct from
   * post-hoc rollback"; issue #129). Deliberately its own small component,
   * not folded into `PermissionQueueBar`'s permission-queue-scoped Stop
   * button (issue #147): this one is reachable from the live session view
   * any time a turn is actually running (`turnActive`), independent of
   * whether a permission request happens to be pending — a user watching a
   * long tool call with no open permission card still needs a one-tap way
   * to cancel it. Renders nothing while no turn is active, so it never
   * competes for space with the composer when there is nothing to stop.
   *
   * `onStop` is expected to call `RelayClient.interruptTurn` (not
   * `cancelPermissionRequests` directly) — see that method's own doc
   * comment for what distinguishes it from a rollback/undo affordance
   * (there is none in this codebase yet; this control's whole point is to
   * exist as its own clearly-named action so one is never added on top of
   * this button later by accident).
   */
  interface Props {
    /** SPEC §7.24 `TranscriptState.turnActive` — true between a `turn_started` and its matching `turn_ended`. */
    turnActive: boolean;
    onStop: () => void;
  }

  const { turnActive, onStop }: Props = $props();
</script>

{#if turnActive}
  <button
    type="button"
    class="turn-stop"
    onclick={onStop}
    aria-label="Stop the running turn"
    data-testid="turn-stop-control"
  >
    <span class="dot" aria-hidden="true"></span>
    Stop
  </button>
{/if}

<style>
  .turn-stop {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    border: 1px solid var(--color-danger);
    color: var(--color-danger);
    background: transparent;
    border-radius: var(--radius-md);
    padding: var(--space-2xs) 0.7rem;
    cursor: pointer;
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  .turn-stop:hover {
    background: var(--color-danger-subtle);
  }

  .dot {
    width: var(--space-sm);
    height: var(--space-sm);
    border-radius: var(--radius-full);
    background: currentColor;
  }
</style>
