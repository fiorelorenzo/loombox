<script lang="ts">
  /**
   * The turn summary bar (issue #740, settled pick C1-3 in
   * `docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §3 "The
   * thread" — this is Lorenzo's Zed screenshot: "Edits · 3 files · +95
   * −17"). Reads `$lib/transcript/turn-review.ts`'s `TurnDiffSummary`,
   * already aggregated from the same `TranscriptToolCallItem.diff` values
   * `EditWriteWidget`/`DiffViewer` render — this component computes
   * nothing about a diff itself, only lays out totals it was handed.
   *
   * Placement (`+page.svelte`'s `.canvas-footer`, directly above the
   * composer form): the composer's own raised-card lift is v7 A1-3 and the
   * terminal dock is v7 D1-2 — both settled, neither re-homed by this
   * work. `.canvas-footer` already hosts `PlanCard`/`QueuedPromptBar` as
   * the "everything above the composer" strip (see that class's own doc
   * comment in `+page.svelte`), so this bar joins that existing strip as
   * one more entry rather than inventing a new chrome region. It is
   * mounted as a SIBLING of `TranscriptTimeline`, not a child of it — #755
   * windows the transcript to the visible range plus overscan, and this
   * bar's totals need every diff-carrying tool call in the turn, mounted
   * or not, so it reads straight off `transcript.items` (the full,
   * unwindowed array `+page.svelte` already holds) instead of whatever
   * `TranscriptTimeline` happens to have on screen.
   *
   * Read-only (the issue's own decision, not a simplification — C1-4's
   * keep/reject was explicitly not picked, depends on #603): this
   * component accepts no mutation callback, and neither of its two
   * `on*` props does anything but navigate (jump to a row already in the
   * transcript, open the read-only Review surface). Nothing here can
   * revert, restore, keep or discard anything on disk.
   *
   * Follows `PlanCard`'s own conventions rather than importing `Card` or
   * `ToolCard`: a `.tool-card` recipe inlined locally (that class's own
   * doc comment explains why — the header/file-list padding here would
   * double up under either shared wrapper), a gutter spacer matching every
   * other transcript-adjacent row, and a disclosure `<button>` using the
   * same `collapse-chevron` icon `EditWriteWidget`'s per-file toggle uses.
   * Expand/collapse state is local and NOT reset per turn (same choice
   * `PlanCard` documents for its own `collapsed` — except that one is
   * lifted to the caller since something else there needs to read it;
   * nothing outside this component needs the toggle, so it stays local
   * here instead).
   */
  import type { TurnDiffSummary } from '$lib/transcript/turn-review';
  import Button from './ui/Button.svelte';
  import Icon from './icons/Icon.svelte';

  interface Props {
    /** `undefined` — the latest turn touched no files, or there is no turn yet — renders nothing at all (issue #740's "a turn with no edits shows no bar" acceptance line). */
    summary: TurnDiffSummary | undefined;
    /** Scrolls the transcript to that file's own diff card — `toolCallId` is `TranscriptToolCallItem.id`, the same row `TranscriptTimeline` mounts. Never mutates anything. */
    onJumpToFile: (toolCallId: string) => void;
    /** Opens the stacked Review Changes surface for this same `summary`. */
    onReviewChanges: () => void;
  }

  const { summary, onJumpToFile, onReviewChanges }: Props = $props();

  let expanded = $state(false);

  function toggleExpanded(): void {
    expanded = !expanded;
  }
</script>

{#if summary}
  <div class="turn-edits-row">
    <div class="turn-edits-gutter" aria-hidden="true"></div>
    <div class="turn-edits-card tool-card" data-testid="turn-edits-bar">
      <div class="turn-edits-header-row">
        <button
          type="button"
          class="turn-edits-header"
          onclick={toggleExpanded}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse edits' : 'Expand edits'}
          data-testid="turn-edits-toggle"
        >
          <Icon name="collapse-chevron" size="0.7em" class="disclosure-icon" />
          <Icon name="tool-edit" class="edits-icon" />
          <span class="label">Edits</span>
          <span class="file-count"
            >{summary.files.length} {summary.files.length === 1 ? 'file' : 'files'}</span
          >
          <span class="stat">
            <span class="added">+{summary.totalAdded}</span>
            <span class="removed">−{summary.totalRemoved}</span>
          </span>
        </button>
        <div class="turn-edits-actions">
          <Button
            variant="ghost"
            size="sm"
            onclick={onReviewChanges}
            dataTestId="turn-edits-review-changes"
          >
            Review Changes
          </Button>
        </div>
      </div>

      {#if expanded}
        <ul class="turn-edits-files">
          {#each summary.files as file (file.toolCallId)}
            <li>
              <button
                type="button"
                class="turn-edits-file-row"
                onclick={() => onJumpToFile(file.toolCallId)}
                data-testid="turn-edits-file-row"
              >
                <Icon name="file" />
                <span class="path">{file.path}</span>
                <span class="stat">
                  <span class="added">+{file.added}</span>
                  <span class="removed">−{file.removed}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Gutter alignment (redesign v3 design spec §3.4, same convention
     `PlanCard`/`QueuedPromptBar` already follow): a spacer the same width
     as every other row's role/kind glyph column, so this card's left edge
     lines up with the rest of the timeline's content instead of starting
     flush at the canvas edge. */
  .turn-edits-row {
    display: flex;
    align-items: flex-start;
    width: 100%;
    min-width: 0;
  }

  .turn-edits-gutter {
    flex: 0 0 var(--gutter);
    width: var(--gutter);
  }

  /* Flat tier (design spec v5 §4 "one card language") — the identical
     recipe `ToolCard`/`PlanCard` give every tool-adjacent surface,
     inlined here for the same reason `PlanCard` inlines it: this header's
     own padding would double up under either shared wrapper. */
  .tool-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
  }

  .turn-edits-card {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--text-small-size);
  }

  .turn-edits-header-row {
    display: flex;
    align-items: center;
    background: var(--color-fill-subtle);
  }

  .turn-edits-header {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    text-align: left;
  }

  /* No `flex-shrink` here: `Icon`'s own scoped root rule already sets it,
     and a call-site declaration for a primitive-bound class loses the
     specificity fight and is silently dropped (issue #665's own test). */
  :global(.disclosure-icon) {
    color: var(--color-text-muted);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  /* Same convention `EditWriteWidget`'s own per-file disclosure uses:
     `collapse-chevron` points down at rest (expanded reading), rotated to
     point right while collapsed — driven off the header button's own
     `aria-expanded`, not a second piece of state duplicating it. */
  .turn-edits-header[aria-expanded='false'] :global(.disclosure-icon) {
    transform: rotate(-90deg);
  }

  :global(.edits-icon) {
    color: var(--color-text-secondary);
  }

  .label {
    font-weight: 600;
  }

  .file-count {
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .stat {
    display: flex;
    gap: var(--space-xs);
    font-family: var(--font-mono);
    white-space: nowrap;
    margin-left: auto;
    padding-right: var(--space-sm);
  }

  .turn-edits-header .stat {
    margin-left: 0;
    padding-right: 0;
  }

  .added {
    color: var(--color-success);
  }

  .removed {
    color: var(--color-danger);
  }

  .turn-edits-actions {
    flex-shrink: 0;
    padding-right: var(--space-sm);
  }

  .turn-edits-files {
    list-style: none;
    margin: 0;
    padding: 0 var(--space-sm) var(--space-xs);
    border-top: 1px solid var(--color-border-subtle);
  }

  .turn-edits-file-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-xs) var(--space-sm);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: inherit;
    text-align: left;
    font-family: var(--font-mono);
  }

  .turn-edits-file-row:hover,
  .turn-edits-file-row:focus-visible {
    background: var(--color-fill-subtle);
  }

  .turn-edits-file-row .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133 — same convention
     `PlanCard`'s own header uses). `var(--touch-target-min)`, not a
     `2.75rem` literal (A2-1, issue #734: see that token's own note in
     `tokens.css`). */
  @media (pointer: coarse) {
    .turn-edits-header,
    .turn-edits-file-row {
      min-height: var(--touch-target-min);
    }
  }

  /* Below `--bp-mobile` the whole role column collapses (see `PlanCard`'s
     identical rule) — a pure spacer, dropped rather than kept when nothing
     lines up with it any more. */
  @media (max-width: 479px) {
    .turn-edits-gutter {
      display: none;
    }
  }
</style>
