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
   * detached transcript-toolbar button. Pairs with a `StatusDot` `pulse` —
   * the brief's `thread-draw` technique (§2) — so the control itself reads
   * as "there's a live, interruptible turn running," not just a static
   * button.
   *
   * Deck migration (issue #469): now actually routes through the shared
   * `Button` primitive (`danger`/`sm`, same visual language this file used
   * to hand-roll) via its `dataTestId` override, which is what keeps this
   * control's own `data-testid="turn-stop-control"` — load-bearing on the
   * existing test — intact across the swap.
   */
  import StatusDot from './ui/StatusDot.svelte';
  import Button from './ui/Button.svelte';

  interface Props {
    /** SPEC §7.24 `TranscriptState.turnActive` — true between a `turn_started` and its matching `turn_ended`. */
    turnActive: boolean;
    onStop: () => void;
  }

  const { turnActive, onStop }: Props = $props();
</script>

{#if turnActive}
  <Button
    variant="danger"
    size="sm"
    onclick={onStop}
    ariaLabel="Stop the running turn"
    dataTestId="turn-stop-control"
  >
    <StatusDot tone="danger" pulse size="sm" label="Turn running" />
    Stop
  </Button>
{/if}
