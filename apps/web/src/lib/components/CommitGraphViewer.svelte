<script lang="ts">
  /**
   * The commit graph / branch tree tab (SPEC §7.6; issue #231) — a dumb,
   * read-only view over `CanvasTabsState.graphViewer`, mirroring
   * `WorktreeDiffViewer`'s own "the host owns the fetch, this view is
   * dumb" contract: `+page.svelte` owns the real `requestCommitGraph`
   * round trip and calls back into `CanvasTabsState.setGraphViewer`/
   * `appendGraphPage`, this component only ever renders what it's given
   * and reports clicks (`onRetry`/`onLoadMore`).
   *
   * Never `git log --graph`'s ASCII art and never a server-computed
   * layout: each row is one commit (short sha, subject, author, relative
   * date, parent-count/merge badge, and every branch/tag decorating it —
   * `GitGraphCommitV1.refs`) in the exact order `computeCommitGraph`
   * returned. A merge commit (`parents.length >= 2`) gets a small
   * "merge" badge; the DAG shape itself (which commit is whose parent)
   * is available in `commit.parents` for a future richer lane-drawing
   * pass, but a flat, readable list is this issue's own "read-only view
   * first" scope.
   *
   * "Load more" appends the next page (`nextOffset`) rather than
   * replacing the list — see `CanvasTabsState.appendGraphPage`'s own
   * doc comment. `loadingMore` is a separate flag from `viewer.status`
   * so paging further in never flips an already-rendered list back to a
   * bare spinner.
   */
  import type { GitGraphCommitV1 } from '@loombox/protocol';
  import type { GraphTabViewerState } from '$lib/tabs.svelte';
  import type { AsyncPanelState } from '$lib/async-panel';
  import AsyncPanel from './ui/AsyncPanel.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';

  interface Props {
    /** `CanvasTabsState.graphViewer`'s current value — loading/loaded/error. */
    viewer: GraphTabViewerState;
    /** Re-runs the same `requestCommitGraph` this tab opened with (page one, `offset: 0`) — the recovery action for a failed load. */
    onRetry: () => void;
    /** A "Load more" fetch is in flight (`CanvasTabsState.graphLoadingMore`) — disables the button and shows its own inline spinner without touching the already-rendered list. */
    loadingMore: boolean;
    /** Fetches the next page at `nextOffset` and appends it. Omitted (or `viewer.nextOffset === null`) renders no "Load more" affordance at all — the walk already reached the ref's root. */
    onLoadMore: () => void;
  }

  const { viewer, onRetry, loadingMore, onLoadMore }: Props = $props();

  /** Reshapes `viewer` (already a `loading | loaded | error` tagged union — never independent booleans) onto the shared primitive (issue #650); the zero-commits case folds into `AsyncPanel`'s own `empty` branch since this panel's message was already `EmptyState`'s exact shape. */
  const graphState = $derived<AsyncPanelState<readonly GitGraphCommitV1[]>>(
    viewer.status === 'loading'
      ? { status: 'loading' }
      : viewer.status === 'error'
        ? { status: 'error', message: viewer.message, retryable: true }
        : viewer.commits.length === 0
          ? { status: 'empty', message: 'No commits yet on this branch.' }
          : { status: 'loaded', data: viewer.commits },
  );

  function shortSha(sha: string): string {
    return sha.slice(0, 7);
  }

  /** `authorDateIso`'s own coarse "how long ago" — same register as a typical commit-list UI (GitHub, `gitk`), never a raw ISO timestamp in the row itself (that still reads on hover via the `title` attribute). */
  function relativeDate(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    const units: [string, number][] = [
      ['year', 31536000],
      ['month', 2592000],
      ['week', 604800],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
    ];
    for (const [label, secondsPerUnit] of units) {
      const value = Math.floor(seconds / secondsPerUnit);
      if (value >= 1) return `${value} ${label}${value === 1 ? '' : 's'} ago`;
    }
    return 'just now';
  }

  function refKindLabel(kind: GitGraphCommitV1['refs'][number]['kind']): string {
    if (kind === 'tag') return 'tag';
    if (kind === 'remoteBranch') return 'remote';
    return 'branch';
  }
</script>

<div class="commit-graph-viewer" data-testid="commit-graph-viewer">
  <AsyncPanel
    state={graphState}
    loadingLabel="Loading commit graph"
    loadingTestId="commit-graph-loading"
    loadingSize="md"
    errorTestId="commit-graph-error"
    {onRetry}
  >
    {#snippet content(commits)}
      <ol class="commit-graph-list" data-testid="commit-graph-list">
        {#each commits as commit (commit.sha)}
          <li class="commit-graph-row" data-testid="commit-graph-row">
            <Card elevation="raised" padding="sm">
              <div class="commit-graph-row-head">
                <span class="commit-graph-sha font-mono" title={commit.sha}>
                  {shortSha(commit.sha)}
                </span>
                {#if commit.parents.length >= 2}
                  <span class="commit-graph-merge-badge" data-testid="commit-graph-merge-badge">
                    merge · {commit.parents.length} parents
                  </span>
                {/if}
                {#if commit.isHead}
                  <span class="commit-graph-head-badge" data-testid="commit-graph-head-badge">
                    HEAD
                  </span>
                {/if}
                {#each commit.refs as ref (ref.name + ref.kind)}
                  <span
                    class="commit-graph-ref-badge"
                    class:tag={ref.kind === 'tag'}
                    data-testid="commit-graph-ref-badge"
                    title={refKindLabel(ref.kind)}
                  >
                    {ref.name}
                  </span>
                {/each}
              </div>
              <p class="commit-graph-subject">{commit.subject}</p>
              <p class="commit-graph-meta">
                <span class="commit-graph-author">{commit.authorName}</span>
                <span class="commit-graph-date" title={commit.authorDateIso}>
                  {relativeDate(commit.authorDateIso)}
                </span>
              </p>
            </Card>
          </li>
        {/each}
      </ol>

      {#if viewer.status === 'loaded' && viewer.nextOffset !== null}
        <div class="commit-graph-load-more">
          <Button
            variant="secondary"
            size="sm"
            loading={loadingMore}
            onclick={onLoadMore}
            dataTestId="commit-graph-load-more"
          >
            Load more
          </Button>
        </div>
      {/if}
    {/snippet}
  </AsyncPanel>
</div>

<style>
  .commit-graph-viewer {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    /* The tab body can be narrower than its own content wants (a phone's
       390px floor, `composer-strip.spec.ts`'s own discipline) — this is
       what lets every row below shrink with it instead of forcing
       horizontal overflow on the viewport. */
    min-width: 0;
  }

  /* `AsyncPanel`'s own `.ui-async-panel-loading` (issue #650) already gives
     `display:flex;align-items:center`; this restates this panel's own
     wider gap/padding — scoped by testid, not class, since the loading
     row now renders inside `AsyncPanel.svelte`'s own template. */
  :global([data-testid='commit-graph-loading']) {
    gap: var(--space-sm);
    padding: var(--space-sm) 0;
  }

  :global([data-testid='commit-graph-error']) {
    padding: var(--space-sm) 0;
  }

  .commit-graph-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    min-width: 0;
  }

  .commit-graph-row {
    min-width: 0;
  }

  .commit-graph-row-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-xs);
    min-width: 0;
  }

  .commit-graph-sha {
    color: var(--color-text-secondary);
    font-size: 0.875em;
  }

  .commit-graph-merge-badge,
  .commit-graph-head-badge,
  .commit-graph-ref-badge {
    font-size: 0.75em;
    padding: 0 var(--space-xs);
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-border);
    white-space: nowrap;
    /* Badges wrap onto their own line rather than pushing the row past
       the viewport — `.commit-graph-row-head`'s own `flex-wrap: wrap`
       is what actually keeps a phone-width row from overflowing when a
       commit carries several branch/tag decorations at once. */
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .commit-graph-head-badge {
    color: var(--color-accent);
    border-color: var(--color-accent);
    font-weight: 600;
  }

  .commit-graph-ref-badge.tag {
    color: var(--color-text-secondary);
  }

  .commit-graph-subject {
    margin: var(--space-xs) 0 0 0;
    /* Never a single unbroken word/hash run off the right edge of a
       narrow viewport — the same overflow discipline every other
       390px-proven surface in this codebase applies to free-text rows. */
    overflow-wrap: break-word;
  }

  .commit-graph-meta {
    margin: var(--space-xs) 0 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    font-size: 0.8125em;
    color: var(--color-text-secondary);
    min-width: 0;
  }

  .commit-graph-author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .commit-graph-load-more {
    display: flex;
    justify-content: center;
    padding: var(--space-sm) 0;
  }
</style>
