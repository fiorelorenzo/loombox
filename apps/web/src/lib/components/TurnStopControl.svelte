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
   *
   * Warp Deck restyle (docs/design/redesign.md §4/§6, issue #439): sits in
   * the composer's own action row, next to Send, so "stop the thing that's
   * running" reads as paired with "send the next thing" rather than a
   * detached transcript-toolbar button. Hand-styled to match `Button`'s
   * `danger`/`sm` visual language (border/hover/tension-press/focus-ring)
   * rather than importing the primitive: this control's own
   * `data-testid="turn-stop-control"` is load-bearing on the existing test
   * (mirrors `PermissionCard`'s identical rationale for its own
   * overflow-toggle). Pairs with a `StatusDot` `pulse` — the brief's
   * `thread-draw` technique (§2) — so the control itself reads as "there's
   * a live, interruptible turn running," not just a static button.
   */
  import StatusDot from './ui/StatusDot.svelte';

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
    <StatusDot tone="danger" pulse size="sm" label="Turn running" />
    Stop
  </button>
{/if}

<style>
  .turn-stop {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    flex-shrink: 0;
    border: 1px solid var(--color-danger);
    color: var(--color-danger);
    background: transparent;
    border-radius: var(--radius-md);
    padding: var(--space-2xs) 0.7rem;
    cursor: pointer;
    font-family: inherit;
    font-size: var(--text-small-size);
    font-weight: 600;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .turn-stop:hover {
    background: var(--color-danger-subtle);
  }

  .turn-stop:active {
    transform: scale(0.98);
    background: var(--color-danger-subtle);
  }

  .turn-stop:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133), the same
     coarse-pointer convention `Button`/`CopyButton` already use. */
  @media (pointer: coarse) {
    .turn-stop {
      min-height: 2.75rem;
    }
  }
</style>
