<script lang="ts">
  /**
   * The unmistakable "this is a replay, not a live session" notice (issue
   * #265's own acceptance bullet: "clearly distinguished in the UI from
   * live session steering"). Sits above `TranscriptTimeline`, outside its
   * own scroll region, so it stays on screen for the whole time replay is
   * active regardless of scroll position — never a toast that fades or a
   * label that scrolls out of view the moment the reader starts reading.
   *
   * Deliberately its own component rather than a conditional line inside
   * `+page.svelte`'s existing agentless notice (`.workspace-notice`):
   * that one explains why the COMPOSER is unavailable for a past session;
   * this one is a different claim entirely — active playback is
   * happening right now, and it says so at the `--color-info` tone (never
   * `--color-warning`/`--color-danger`, which this app already reserves
   * for something being wrong) plus a literal exit control, not a passive
   * notice a reader might read once and then ignore for the rest of the
   * session.
   */
  import Icon from './icons/Icon.svelte';
  import IconButton from './ui/IconButton.svelte';

  interface Props {
    onExit: () => void;
  }

  const { onExit }: Props = $props();
</script>

<div class="replay-banner" data-testid="session-replay-banner" role="status">
  <Icon name="play" class="replay-banner-icon" />
  <div class="replay-banner-copy">
    <span class="replay-banner-title">Replaying a past session</span>
    <span class="replay-banner-detail">
      Not live — nothing here reaches an agent. Pacing is reconstructed for readability, not the
      session's real timing.
    </span>
  </div>
  <IconButton label="Exit replay" size="sm" onclick={onExit} dataTestId="exit-replay-button">
    <Icon name="close" />
  </IconButton>
</div>

<style>
  .replay-banner {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--color-info);
    border-radius: var(--radius-md);
    background: var(--color-info-subtle);
    margin-bottom: var(--space-sm);
  }

  :global(.replay-banner-icon) {
    flex-shrink: 0;
    color: var(--color-info);
  }

  .replay-banner-copy {
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
    min-width: 0;
    flex: 1;
  }

  .replay-banner-title {
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .replay-banner-detail {
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  /* 390px (issue #265's own verification bar): the detail sentence wraps
     onto its own lines rather than forcing the banner wider than the
     canvas — nothing here needs a breakpoint of its own, flex already
     handles it, this just documents that it was checked. */
</style>
