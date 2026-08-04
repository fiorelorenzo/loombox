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
   * the composer's own action row, in the same slot Send occupies while no
   * turn is running — never beside it (see `+page.svelte`'s composer
   * markup), so "stop the thing that's running" reads as the one live
   * action available, not a second competing button.
   *
   * A3-2 (issue #666, v7 §1, 2026-08-04 decisions): used to pair a pulsing
   * `StatusDot` on the button itself — "there's a live, interruptible turn
   * running" welded onto the control. That pairing is gone: progress now
   * belongs to the turn, rendered as its own live line in the transcript
   * (`+page.svelte`'s `turnProgressVisible`/`.turn-progress`), not to this
   * button. This is now `size="md"`, not the old `sm` — it used to sit
   * next to a disabled-but-present `md` Send button and read fine smaller;
   * now it single-handedly occupies Send's exact slot, and matching size
   * is what keeps that swap from visibly resizing the slot.
   *
   * Deck migration (issue #469): routes through the shared `Button`
   * primitive (`danger`, same visual language this file used to hand-roll)
   * via its `dataTestId` override, which is what keeps this control's own
   * `data-testid="turn-stop-control"` — load-bearing on the existing test —
   * intact across the swap.
   */
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
    onclick={onStop}
    ariaLabel="Stop the running turn"
    dataTestId="turn-stop-control"
  >
    Stop
  </Button>
{/if}
