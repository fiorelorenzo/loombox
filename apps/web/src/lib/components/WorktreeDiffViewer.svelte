<script lang="ts">
  /**
   * The working-tree diff viewer (SPEC §7.4 "inline/split diff viewer for
   * reviewing agent changes... the same component as the tool-call diff",
   * issue #206) — what has actually changed in the session's worktree
   * right now (staged + unstaged + untracked, node-side `git status`/`git
   * show` over `@loombox/protocol`'s `git_diff_request`/`git_diff_response`
   * pair, `packages/node/src/git-diff.ts`), as opposed to
   * `ReviewChangesDialog`'s per-TURN stack of ACP `Diff`s a tool call
   * already reported. Opens as a tab in the canvas tab strip (issue #737,
   * `$lib/tabs.svelte.ts`'s `DiffCanvasTab`/`DiffTabViewerState`) — a
   * `+page.svelte`-owned surface, never a dialog of its own.
   *
   * Reuses, never duplicates:
   * - Inline mode renders each file through `DiffViewer` UNCHANGED — the
   *   exact same component the tool-call diff card and `ReviewChangesDialog`
   *   already mount, given the exact same `{path, oldText, newText}` ACP
   *   shape (a binary/symlink change collapsing to `oldText: null,
   *   newText: ''` node-side, `DiffViewer`'s own existing structural-only
   *   fallback — never a second "this is binary" rendering here).
   * - Split mode reuses `$lib/diff.ts`'s `diffStats`/`pairDiffLinesForSplitView`
   *   — the exact same `computeLineDiff` LCS output `DiffViewer` itself
   *   renders one line after another, only re-shaped into side-by-side
   *   rows. There is no second diff ALGORITHM anywhere in this file; only
   *   the two-column presentation is new (`DiffViewer` has no split layout
   *   of its own to reuse for that part).
   * - `renameNote` reads `GitDiffFileV1.status`/`previousPath` (this pair's
   *   own addition on top of ACP's `Diff` shape, `packages/protocol/src/v1/
   *   git-diff.ts`) — `DiffViewer` itself takes no status prop, so a
   *   rename's own "renamed from" annotation renders in this file, once,
   *   above whichever renderer (inline or split) is showing that file.
   *
   * Narrow-viewport honesty (issue #206's own acceptance line): below
   * `TABLET_VIEWPORT_BREAKPOINT_PX` two side-by-side columns have nowhere
   * to go — each pane would be narrower than the single unified column
   * inline mode already gives, strictly worse, not a real alternative.
   * Split silently degrades to inline there (`mode`'s own `$derived`), not
   * merely CSS-hidden: the narrow case never even computes
   * `pairDiffLinesForSplitView`'s rows. The toggle itself stays visible but
   * its Split option is disabled, so a caller resizing back up to tablet
   * width sees its own last choice honored rather than silently reset.
   */
  import type {
    GitDiffFileStatusV1,
    GitDiffFileV1,
    GitHunkFileV1,
    GitHunkV1,
  } from '@loombox/protocol';
  import { diffStats, pairDiffLinesForSplitView } from '$lib/diff';
  import type { DiffTabViewerState, HunkTabViewerState } from '$lib/tabs.svelte';
  import { isNarrowViewport, TABLET_VIEWPORT_BREAKPOINT_PX } from '$lib/viewport';
  import { Icon } from './icons';
  import CopyButton from './CopyButton.svelte';
  import DiffViewer from './DiffViewer.svelte';
  import WovenLoader from './WovenLoader.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import IconButton from './ui/IconButton.svelte';

  interface Props {
    /** `CanvasTabsState.diffViewer`'s current value — loading/loaded/error. */
    viewer: DiffTabViewerState;
    /** Re-runs the same `requestWorktreeDiff` this tab opened with — the only recovery action this read-only viewer offers for a failed load. */
    onRetry: () => void;
    /** `CanvasTabsState.hunkViewer`'s current value (issue #232's staging surface) — loading/loaded/error, fetched and refreshed independently of {@link viewer}. */
    hunkViewer: HunkTabViewerState;
    /** Re-runs the same `requestGitHunkDiff` the staging surface opened with — {@link onRetry}'s own sibling for the hunk side. */
    onRetryHunks: () => void;
    /** Stages `unstaged[hunkIndex]` of the file at `path` (issue #232). The caller owns the actual `applyGitHunkAction` relay call and re-fetches {@link hunkViewer} (and typically {@link viewer} too) once it settles — this view only ever reports the click. */
    onStageHunk: (path: string, hunkIndex: number) => void;
    /** Unstages `staged[hunkIndex]` of the file at `path` — {@link onStageHunk}'s own sibling for the opposite side. */
    onUnstageHunk: (path: string, hunkIndex: number) => void;
    /** Opens `DiscardHunkDialog` for `unstaged[hunkIndex]` of the file at `path` — discard is destructive, so unlike stage/unstage this view never applies it directly; the caller owns the confirmation dialog (`+page.svelte`'s own "the dialog that triggers a real relay call owns that call" convention, `DiscardHunkDialog`'s file doc comment). */
    onDiscardHunk: (path: string, hunkIndex: number, hunk: GitHunkV1) => void;
    /** Opens `path` in the canvas tab strip's read-only file viewer (issue #737) — forwarded to each file's `DiffViewer`, exactly like `ReviewChangesDialog`'s own `onOpenFile` wiring. Omitted renders no "Open" affordance anywhere in this view. */
    onOpenFile?: (path: string) => void;
  }

  const {
    viewer,
    onRetry,
    hunkViewer,
    onRetryHunks,
    onStageHunk,
    onUnstageHunk,
    onDiscardHunk,
    onOpenFile,
  }: Props = $props();

  type DiffDisplayMode = 'inline' | 'split';
  let requestedMode = $state<DiffDisplayMode>('inline');

  /** Which of the two independently-fetched surfaces (issue #206's read-only diff vs issue #232's staging view) is showing right now — a plain local toggle, not persisted, mirroring `requestedMode` immediately below. */
  type WorktreeDiffSurface = 'diff' | 'staging';
  let surface = $state<WorktreeDiffSurface>('diff');

  const narrowForSplit = isNarrowViewport(TABLET_VIEWPORT_BREAKPOINT_PX);
  const mode = $derived<DiffDisplayMode>($narrowForSplit ? 'inline' : requestedMode);

  function renameNote(file: {
    status: GitDiffFileStatusV1;
    previousPath: string | null;
  }): string | undefined {
    return file.status === 'renamed' && file.previousPath
      ? `Renamed from ${file.previousPath}`
      : undefined;
  }

  interface NumberedHunkLine {
    kind: GitHunkV1['lines'][number]['kind'];
    text: string;
    oldLineNumber: number | null;
    newLineNumber: number | null;
  }

  /** Assigns each of `hunk.lines` its own old/new line number by walking `hunk.oldStart`/`hunk.newStart` forward — `GitHunkLineV1` itself carries no line number (only `kind`/`text`, `@loombox/protocol`'s `git-hunks.ts` doc comment), so this view derives the same `.diff-lines` old/new gutter `DiffViewer` already renders from each line's own position within the hunk. */
  function numberedHunkLines(hunk: GitHunkV1): NumberedHunkLine[] {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    return hunk.lines.map((line) => {
      if (line.kind === 'removed') {
        const row = {
          kind: line.kind,
          text: line.text,
          oldLineNumber: oldLine,
          newLineNumber: null,
        };
        oldLine += 1;
        return row;
      }
      if (line.kind === 'added') {
        const row = {
          kind: line.kind,
          text: line.text,
          oldLineNumber: null,
          newLineNumber: newLine,
        };
        newLine += 1;
        return row;
      }
      const row = {
        kind: line.kind,
        text: line.text,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      };
      oldLine += 1;
      newLine += 1;
      return row;
    });
  }
</script>

{#snippet splitFile(file: GitDiffFileV1)}
  {@const stats = diffStats(file.oldText, file.newText)}
  {@const rows = stats.hasText ? pairDiffLinesForSplitView(stats.lines) : []}
  {@const note = renameNote(file)}
  <div class="worktree-diff-file" data-testid="worktree-diff-file">
    <Card elevation="raised" padding="none" class="worktree-diff-split-card">
      <div class="diff-header">
        <span class="diff-path font-mono">{file.path}</span>
        {#if stats.hasText}
          <span class="diff-stats font-mono">
            <span class="added">+{stats.added}</span>
            <span class="removed">-{stats.removed}</span>
          </span>
        {/if}
        {#if onOpenFile}
          <IconButton
            label={`Open ${file.path}`}
            size="sm"
            onclick={() => onOpenFile(file.path)}
            class="copy-button-reveal"
            dataTestId="worktree-diff-split-open"
          >
            <Icon name="file" />
          </IconButton>
        {/if}
        <CopyButton
          text={stats.hasText ? file.newText : `${file.path} (binary/symlink change)`}
          label={`Copy diff for ${file.path}`}
          revealOnHover
        />
      </div>
      {#if note}
        <p class="worktree-diff-rename-note">{note}</p>
      {/if}
      {#if stats.hasText}
        <div class="split-panes">
          <ol class="split-pane" data-testid="worktree-diff-split-old">
            {#each rows as row, index (index)}
              <li class={row.left?.kind ?? 'blank'}>
                <span class="line-no">{row.left?.oldLineNumber ?? ''}</span>
                <span class="text">{row.left?.text ?? ''}</span>
              </li>
            {/each}
          </ol>
          <ol class="split-pane" data-testid="worktree-diff-split-new">
            {#each rows as row, index (index)}
              <li class={row.right?.kind ?? 'blank'}>
                <span class="line-no">{row.right?.newLineNumber ?? ''}</span>
                <span class="text">{row.right?.text ?? ''}</span>
              </li>
            {/each}
          </ol>
        </div>
      {:else}
        <p class="structural-only" data-testid="worktree-diff-split-structural">
          Binary or symlink change — no line-level diff available for
          <span class="font-mono">{file.path}</span>.
        </p>
      {/if}
    </Card>
  </div>
{/snippet}

{#snippet hunkLines(hunk: GitHunkV1)}
  <ol class="diff-lines">
    {#each numberedHunkLines(hunk) as line, lineIndex (lineIndex)}
      <li class={line.kind}>
        <span class="line-no old">{line.oldLineNumber ?? ''}</span>
        <span class="line-no new">{line.newLineNumber ?? ''}</span>
        <span class="marker"
          >{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span
        >
        <span class="text">{line.text}</span>
      </li>
    {/each}
  </ol>
{/snippet}

{#snippet hunkSide(path: string, side: 'staged' | 'unstaged', hunks: readonly GitHunkV1[])}
  {#if hunks.length > 0}
    <div class="hunk-side" data-testid={`hunk-side-${side}`}>
      <h4 class="hunk-side-title">{side === 'staged' ? 'Staged' : 'Unstaged'}</h4>
      {#each hunks as hunk, hunkIndex (hunkIndex)}
        <div class="hunk-block" data-testid="hunk-block">
          <div class="hunk-header font-mono">
            <span class="hunk-header-text">{hunk.header}</span>
            <div class="hunk-actions">
              {#if side === 'unstaged'}
                <Button
                  variant="secondary"
                  size="sm"
                  onclick={() => onStageHunk(path, hunkIndex)}
                  dataTestId="hunk-stage-button"
                >
                  Stage hunk
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onclick={() => onDiscardHunk(path, hunkIndex, hunk)}
                  dataTestId="hunk-discard-button"
                >
                  Discard
                </Button>
              {:else}
                <Button
                  variant="secondary"
                  size="sm"
                  onclick={() => onUnstageHunk(path, hunkIndex)}
                  dataTestId="hunk-unstage-button"
                >
                  Unstage hunk
                </Button>
              {/if}
            </div>
          </div>
          {@render hunkLines(hunk)}
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet stagingFile(file: GitHunkFileV1)}
  {@const note = renameNote(file)}
  <div class="worktree-diff-file" data-testid="hunk-file">
    <Card elevation="raised" padding="none">
      <div class="diff-header">
        <span class="diff-path font-mono">{file.path}</span>
        <span class="hunk-file-status">{file.status}</span>
      </div>
      {#if note}
        <p class="worktree-diff-rename-note">{note}</p>
      {/if}
      {@render hunkSide(file.path, 'staged', file.staged)}
      {@render hunkSide(file.path, 'unstaged', file.unstaged)}
    </Card>
  </div>
{/snippet}

<div class="worktree-diff-viewer" data-testid="worktree-diff-viewer">
  <div class="worktree-diff-surface" role="radiogroup" aria-label="Working-tree view">
    <Button
      variant="ghost"
      size="sm"
      class={`surface-choice ${surface === 'diff' ? 'selected' : ''}`.trim()}
      role="radio"
      ariaChecked={surface === 'diff'}
      tabindex={surface === 'diff' ? 0 : -1}
      onclick={() => (surface = 'diff')}
      dataTestId="worktree-diff-surface-diff"
    >
      Diff
    </Button>
    <Button
      variant="ghost"
      size="sm"
      class={`surface-choice ${surface === 'staging' ? 'selected' : ''}`.trim()}
      role="radio"
      ariaChecked={surface === 'staging'}
      tabindex={surface === 'staging' ? 0 : -1}
      onclick={() => (surface = 'staging')}
      dataTestId="worktree-diff-surface-staging"
    >
      Stage changes
    </Button>
  </div>

  {#if surface === 'diff'}
    {#if viewer.status === 'loading'}
      <div class="worktree-diff-loading" data-testid="worktree-diff-loading">
        <WovenLoader size="md" label="Loading working-tree diff" />
      </div>
    {:else if viewer.status === 'error'}
      <div class="worktree-diff-error">
        <ErrorNotice message={viewer.message} retryable {onRetry} />
      </div>
    {:else if viewer.files.length === 0}
      <EmptyState message="No uncommitted changes in this project's worktree." />
    {:else}
      <div class="worktree-diff-toolbar">
        <div class="worktree-diff-mode" role="radiogroup" aria-label="Diff display mode">
          <Button
            variant="ghost"
            size="sm"
            class={`mode-choice ${mode === 'inline' ? 'selected' : ''}`.trim()}
            role="radio"
            ariaChecked={mode === 'inline'}
            tabindex={mode === 'inline' ? 0 : -1}
            onclick={() => (requestedMode = 'inline')}
            dataTestId="worktree-diff-mode-inline"
          >
            Inline
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class={`mode-choice ${mode === 'split' ? 'selected' : ''}`.trim()}
            role="radio"
            ariaChecked={mode === 'split'}
            tabindex={mode === 'split' ? 0 : -1}
            disabled={$narrowForSplit}
            title={$narrowForSplit ? 'Split view needs a wider window' : undefined}
            onclick={() => (requestedMode = 'split')}
            dataTestId="worktree-diff-mode-split"
          >
            Split
          </Button>
        </div>
        <span class="worktree-diff-count">
          {viewer.files.length}
          {viewer.files.length === 1 ? 'file' : 'files'}
        </span>
      </div>

      <div class="worktree-diff-files" data-testid="worktree-diff-files">
        {#each viewer.files as file (file.path)}
          {#if mode === 'inline'}
            {@const note = renameNote(file)}
            <div class="worktree-diff-file" data-testid="worktree-diff-file">
              {#if note}
                <p class="worktree-diff-rename-note">{note}</p>
              {/if}
              <DiffViewer
                path={file.path}
                oldText={file.oldText}
                newText={file.newText}
                onOpen={onOpenFile ? () => onOpenFile(file.path) : undefined}
              />
            </div>
          {:else}
            {@render splitFile(file)}
          {/if}
        {/each}
      </div>
    {/if}
  {:else if hunkViewer.status === 'loading'}
    <div class="worktree-diff-loading" data-testid="worktree-hunk-loading">
      <WovenLoader size="md" label="Loading staged/unstaged hunks" />
    </div>
  {:else if hunkViewer.status === 'error'}
    <div class="worktree-diff-error">
      <ErrorNotice message={hunkViewer.message} retryable onRetry={onRetryHunks} />
    </div>
  {:else if hunkViewer.files.length === 0}
    <EmptyState message="No uncommitted changes in this project's worktree." />
  {:else}
    <div class="worktree-diff-files" data-testid="worktree-hunk-files">
      {#each hunkViewer.files as file (file.path)}
        {@render stagingFile(file)}
      {/each}
    </div>
  {/if}
</div>

<style>
  .worktree-diff-viewer {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-md);
    gap: var(--space-md);
  }

  .worktree-diff-surface {
    display: flex;
    gap: var(--space-2xs);
  }

  :global(.worktree-diff-surface .surface-choice.selected) {
    background: var(--color-accent-subtle);
    color: var(--color-accent);
  }

  .hunk-file-status {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
    text-transform: capitalize;
  }

  .hunk-side {
    display: flex;
    flex-direction: column;
  }

  .hunk-side-title {
    margin: 0;
    padding: var(--space-2xs) var(--space-sm);
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .hunk-block + .hunk-block {
    border-top: 1px solid var(--color-border-subtle);
  }

  .hunk-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    padding: var(--space-2xs) var(--space-sm);
    background: var(--color-fill-subtle);
  }

  .hunk-header-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hunk-actions {
    display: flex;
    gap: var(--space-2xs);
    flex-shrink: 0;
  }

  .worktree-diff-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-2xl) 0;
  }

  .worktree-diff-error {
    padding: var(--space-sm) 0;
  }

  .worktree-diff-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
  }

  .worktree-diff-mode {
    display: flex;
    gap: var(--space-2xs);
  }

  :global(.worktree-diff-mode .mode-choice.selected) {
    background: var(--color-accent-subtle);
    color: var(--color-accent);
  }

  .worktree-diff-count {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .worktree-diff-files {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .worktree-diff-rename-note {
    margin: 0;
    padding: var(--space-2xs) var(--space-sm);
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
    font-style: italic;
  }

  :global(.worktree-diff-split-card) {
    overflow: hidden;
    font-size: var(--text-code-size);
    width: 100%;
    min-width: 0;
  }

  .diff-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-fill-subtle);
    border-bottom: 1px solid var(--color-border-subtle);
    font-family: var(--font-mono);
  }

  .diff-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diff-stats .added {
    color: var(--color-success);
  }

  .diff-stats .removed {
    color: var(--color-danger);
    margin-left: var(--space-xs);
  }

  .structural-only {
    padding: var(--space-sm);
    opacity: 0.75;
    margin: 0;
  }

  /* Split mode's own two-column layout — the one piece of markup this file
     genuinely adds (see the file doc comment: everything feeding it comes
     from `$lib/diff.ts`'s existing diff computation). Each pane scrolls
     independently on a long line, mirroring `DiffViewer`'s own
     `.diff-lines`; the panes share a single vertical scroll via this
     component's own `.worktree-diff-viewer` ancestor. */
  .split-panes {
    display: flex;
    min-width: 0;
  }

  .split-pane {
    flex: 1 1 50%;
    min-width: 0;
    list-style: none;
    margin: 0;
    padding: 0;
    font-family: var(--font-mono);
    overflow-x: auto;
  }

  .split-pane:first-child {
    border-right: 1px solid var(--color-border-subtle);
  }

  .split-pane li {
    display: flex;
    width: fit-content;
    min-width: 100%;
    white-space: pre;
    padding: 0 var(--space-sm);
  }

  .split-pane li.added {
    background: var(--color-success-subtle);
  }

  .split-pane li.removed {
    background: var(--color-danger-subtle);
  }

  .split-pane li.blank {
    opacity: 0.35;
  }

  .split-pane .line-no {
    display: inline-block;
    width: 2.5rem;
    text-align: right;
    opacity: 0.45;
    flex-shrink: 0;
    padding-right: var(--space-sm);
    user-select: none;
  }

  :global(.worktree-diff-split-card:hover .copy-button-reveal),
  :global(.worktree-diff-split-card:focus-within .copy-button-reveal) {
    opacity: 1;
  }
</style>
