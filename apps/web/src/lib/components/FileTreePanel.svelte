<script lang="ts">
  /**
   * The read-only file-tree panel for a session's project (SPEC §7.4; issue
   * #171): browse the tree, lazily expanding one directory at a time —
   * never the whole tree up front. Works identically for a `local` or
   * `ssh:` target project, since both are driven through the exact same
   * `RelayClient.fileTreeFor`/`expandDirectory` API backed by the
   * encrypted `fs_list_request`/`fs_list_response` pair (`$lib/relay-client.ts`;
   * `packages/node/src/target.ts`'s `ExecutionTarget.readdirDetailed`) — this
   * component has no idea which kind of target it's rendering.
   *
   * `tree` is `RelayClient.fileTreeFor(sessionId)`'s current value (the
   * caller subscribes and passes the latest snapshot down, same convention
   * as every other `$lib/relay-client.ts`-backed prop elsewhere in this
   * app). Expand/collapse state (`expandedPaths`) is local UI state, kept
   * separate from the tree's own load state: collapsing and re-expanding a
   * directory must not re-fetch it (`RelayClient.expandDirectory` is
   * already a no-op for an already-`'loaded'` path, but there is no reason
   * to even call it again). No create/rename/delete affordances — v1 is
   * deliberately read-only (issue #171's acceptance criteria).
   */
  import type { FsEntryV1 } from '@loombox/protocol';
  import { SvelteSet } from 'svelte/reactivity';
  import { joinTreePath, sortEntries } from '../file-tree';
  import type { FileTreeDirectoryState } from '../relay-client';

  interface Props {
    tree: Map<string, FileTreeDirectoryState>;
    onExpand: (path: string) => void;
    /** Fired when the user clicks a file row — e.g. to open it, or to reuse this panel as a picker surface. Omit for a purely browsable, non-interactive-on-file tree. */
    onSelectFile?: (path: string) => void;
  }

  const { tree, onExpand, onSelectFile }: Props = $props();

  const expandedPaths = new SvelteSet<string>();

  function toggle(path: string): void {
    if (expandedPaths.has(path)) {
      expandedPaths.delete(path);
    } else {
      expandedPaths.add(path);
      // Only fetches if this path isn't already loading/loaded — see
      // `RelayClient.expandDirectory`'s own idempotency doc comment.
      onExpand(path);
    }
  }

  function entriesFor(path: string): FsEntryV1[] {
    const dirState = tree.get(path);
    if (!dirState || dirState.status !== 'loaded') return [];
    return [...dirState.entries].sort(sortEntries);
  }
</script>

{#snippet dirContents(path: string)}
  {@const dirState = tree.get(path)}
  {#if dirState?.status === 'loading'}
    <p class="tree-status loading" data-testid="file-tree-loading">Loading…</p>
  {:else if dirState?.status === 'error'}
    <p class="tree-status error" role="alert" data-testid="file-tree-error">{dirState.error}</p>
  {/if}
  <ul class="tree-entries">
    {#each entriesFor(path) as entry (entry.name)}
      {@const entryPath = joinTreePath(path, entry.name)}
      <li>
        {#if entry.kind === 'dir'}
          <button
            type="button"
            class="tree-row dir"
            onclick={() => toggle(entryPath)}
            aria-expanded={expandedPaths.has(entryPath)}
            data-testid="file-tree-dir"
          >
            <span class="icon" aria-hidden="true">{expandedPaths.has(entryPath) ? '▾' : '▸'}</span>
            <span class="name">{entry.name}</span>
          </button>
          {#if expandedPaths.has(entryPath)}
            <div class="tree-children">
              {@render dirContents(entryPath)}
            </div>
          {/if}
        {:else}
          <button
            type="button"
            class="tree-row file"
            onclick={() => onSelectFile?.(entryPath)}
            data-testid="file-tree-file"
          >
            <span class="icon" aria-hidden="true">{entry.kind === 'symlink' ? '🔗' : '📄'}</span>
            <span class="name">{entry.name}</span>
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<nav class="file-tree" aria-label="Project files" data-testid="file-tree-panel">
  {@render dirContents('')}
</nav>

<style>
  .file-tree {
    font-family: var(--font-mono);
    font-size: var(--text-code-size);
    overflow-y: auto;
  }

  .tree-status {
    margin: 0;
    padding: var(--space-3xs) var(--space-xs);
    opacity: 0.65;
    font-size: var(--text-small-size);
  }

  .tree-status.error {
    color: var(--color-danger);
    opacity: 1;
  }

  .tree-entries {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .tree-children .tree-entries {
    padding-left: 0.9rem;
  }

  .tree-row {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: var(--space-3xs) var(--space-2xs);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font: inherit;
  }

  .tree-row:hover {
    background: var(--color-fill-subtle);
  }

  .icon {
    flex-shrink: 0;
    width: 1.1rem;
    text-align: center;
    opacity: 0.75;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
