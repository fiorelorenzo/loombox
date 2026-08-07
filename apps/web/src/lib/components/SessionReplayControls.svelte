<script lang="ts">
  /**
   * Replaces the composer while a replay is active (issue #265's own
   * acceptance bullets: pause/resume/scrub, a controllable pace). Never
   * rendered alongside the real composer — `+page.svelte` swaps one for
   * the other, so there is never a moment where both a "Send" and a
   * "Play" control sit in the same slot claiming to do different things.
   *
   * Speed is a `role="radiogroup"` (mutually exclusive, always exactly
   * one selected), mirroring `ConfigBar.svelte`'s own `mode` segmented
   * control: roving `tabindex`, arrow keys move the selection AND focus
   * together, one tab stop for the whole group — the same reasoning that
   * component's own file doc comment already spells out for why this
   * isn't `aria-pressed` on four independent buttons.
   */
  import { REPLAY_SPEEDS, SessionReplay } from '$lib/transcript/replay.svelte';
  import Button from './ui/Button.svelte';
  import Icon from './icons/Icon.svelte';
  import IconButton from './ui/IconButton.svelte';

  interface Props {
    replay: SessionReplay;
  }

  const { replay }: Props = $props();

  let speedGroupEl = $state<HTMLElement | undefined>(undefined);

  const playPauseLabel = $derived(
    replay.playing ? 'Pause replay' : replay.finished ? 'Replay from the start' : 'Play replay',
  );

  function handleScrub(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    replay.seekMs(Number(target.value));
  }

  function handleSpeedKeydown(event: KeyboardEvent): void {
    let delta: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        delta = 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        delta = -1;
        break;
      default:
        return;
    }
    event.preventDefault();

    const currentIndex = REPLAY_SPEEDS.indexOf(replay.speed);
    const nextIndex =
      (Math.max(currentIndex, 0) + delta + REPLAY_SPEEDS.length) % REPLAY_SPEEDS.length;
    const nextSpeed = REPLAY_SPEEDS[nextIndex];
    if (nextSpeed === undefined) return;
    replay.setSpeed(nextSpeed);
    speedGroupEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
  }
</script>

<div class="replay-controls" data-testid="session-replay-controls">
  <div class="replay-controls-row">
    <IconButton
      label={playPauseLabel}
      onclick={() => replay.toggle()}
      dataTestId="replay-play-pause"
    >
      <Icon name={replay.playing ? 'pause' : 'play'} />
    </IconButton>
    <IconButton
      label="Restart replay"
      size="sm"
      onclick={() => replay.restart()}
      dataTestId="replay-restart"
    >
      <Icon name="refresh" />
    </IconButton>
    <input
      class="replay-scrub"
      type="range"
      min="0"
      max={replay.totalDurationMs}
      value={replay.positionMs}
      oninput={handleScrub}
      aria-label="Replay position"
      aria-valuetext={`step ${replay.revealedCount} of ${replay.items.length}`}
      data-testid="replay-scrub"
    />
    <span class="replay-progress" data-testid="replay-progress" aria-live="polite">
      {replay.revealedCount} / {replay.items.length} steps
    </span>
  </div>
  <div class="replay-controls-row">
    <div
      class="replay-speed-group"
      role="radiogroup"
      aria-label="Replay speed"
      data-testid="replay-speed-group"
      bind:this={speedGroupEl}
    >
      {#each REPLAY_SPEEDS as speedOption (speedOption)}
        <button
          type="button"
          class="replay-speed-choice"
          class:selected={replay.speed === speedOption}
          role="radio"
          aria-checked={replay.speed === speedOption}
          tabindex={replay.speed === speedOption ? 0 : -1}
          onclick={() => replay.setSpeed(speedOption)}
          onkeydown={handleSpeedKeydown}
          data-testid="replay-speed-option"
        >
          {speedOption}×
        </button>
      {/each}
    </div>
    <Button
      size="sm"
      variant="secondary"
      disabled={replay.finished}
      onclick={() => replay.skipToEnd()}
      dataTestId="replay-skip-to-end"
    >
      Skip to end
    </Button>
  </div>
</div>

<style>
  .replay-controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .replay-controls-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .replay-scrub {
    flex: 1;
    min-width: 6rem;
    accent-color: var(--color-accent);
  }

  .replay-progress {
    flex-shrink: 0;
    min-width: 8ch;
    text-align: right;
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .replay-speed-group {
    display: flex;
    gap: var(--space-2xs);
  }

  .replay-speed-choice {
    padding: var(--space-2xs) var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
    font-family: var(--font-mono);
    cursor: pointer;
    transition:
      background var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat),
      color var(--duration-fast) var(--ease-beat);
  }

  .replay-speed-choice:hover {
    border-color: var(--color-border-strong);
  }

  .replay-speed-choice.selected {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
    color: var(--color-text-primary);
  }

  .replay-speed-choice:focus-visible {
    outline: 1px solid var(--color-focus-ring);
    outline-offset: 1px;
  }

  /* 390px: both rows already wrap via `flex-wrap` above rather than
     needing a dedicated breakpoint — the scrub row's own `min-width:
     6rem` on `.replay-scrub` is what keeps the slider from getting
     squeezed to nothing beside the progress label first. */
</style>
