<script lang="ts">
  /**
   * The Review Changes surface (issue #740, settled pick C1-3): stacks
   * every file the current turn changed with its diff in place, so reading
   * the whole turn stops meaning scroll-and-remember across separate tool
   * cards. Renders `DiffViewer` per file — the exact same component
   * `EditWriteWidget` mounts for a live tool card, given the exact same
   * `path`/`oldText`/`newText` off `TurnDiffSummary.files` (itself read
   * straight off each `TranscriptToolCallItem.diff` by
   * `$lib/transcript/turn-review.ts`) — so this surface and the tool cards
   * it stacks are provably reading the same diffs from the same source,
   * not a second diff implementation rendering a second opinion of them.
   *
   * Read-only (the issue's own decision, not a simplification — C1-4's
   * keep/reject was explicitly not picked and depends on #603): the only
   * interactive controls in this file are `Dialog`'s own close affordances
   * (Esc, backdrop click, the header close button `Dialog` renders itself)
   * and each `DiffViewer`'s existing `CopyButton` — nothing here reverts,
   * restores, keeps, or discards anything on disk.
   *
   * Built on the shared `ui/Dialog` primitive (redesign brief §4, issue
   * #428) rather than a hand-rolled overlay, the same convention every
   * other dialog in this package (`ArchiveSessionDialog`, `NewSessionDialog`,
   * …) already follows — `size="lg"` since a stack of diff cards is wider
   * content than this primitive's `sm`/`md` tiers assume.
   */
  import type { TurnDiffSummary } from '$lib/transcript/turn-review';
  import DiffViewer from './DiffViewer.svelte';
  import Dialog from './ui/Dialog.svelte';

  interface Props {
    open: boolean;
    /** Same source as the bar that opened this — `undefined` while `open` is only possible for one render tick around a session switch; the dialog renders an empty body rather than throwing. */
    summary: TurnDiffSummary | undefined;
    onClose: () => void;
  }

  const { open, summary, onClose }: Props = $props();
</script>

{#snippet body()}
  <div class="review-files" data-testid="review-changes-files">
    {#if summary}
      {#each summary.files as file (file.toolCallId)}
        <div class="review-file" data-testid="review-changes-file">
          <DiffViewer path={file.path} oldText={file.oldText} newText={file.newText} />
        </div>
      {/each}
    {/if}
  </div>
{/snippet}

<Dialog
  {open}
  label="Review Changes"
  {onClose}
  size="lg"
  class="review-changes-panel"
  children={body}
>
  {#snippet header()}
    <h2>Review Changes</h2>
    {#if summary}
      <p class="review-file-count">
        {summary.files.length}
        {summary.files.length === 1 ? 'file' : 'files'}
      </p>
    {/if}
  {/snippet}
</Dialog>

<style>
  :global(.review-changes-panel) {
    width: min(56rem, 100%);
  }

  .review-file-count {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .review-files {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .review-file :global(.diff-viewer) {
    max-width: none;
  }
</style>
