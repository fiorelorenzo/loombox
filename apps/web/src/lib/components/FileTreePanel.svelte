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
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §4/§5/§6,
   * issue #435): the disclosure chevron rotates with a
   * `--duration-fast`/`--ease-beat` transform (a quiet, one-job motion, not
   * `thread-draw` — that primitive is reserved for fills/reveals, not a
   * toggle rotation); a freshly-expanded directory's children get a
   * `beat-in`-style 4px slide + fade (the brief's "list row appearing" job);
   * and a directory that loads with zero entries reads through `EmptyState`
   * instead of a silent empty `<ul>`.
   *
   * Deck migration (redesign v2, issue #467): every row glyph (folder,
   * file, the disclosure chevron) now draws from the shared bespoke
   * `Icon` component (`./icons`) instead of this component's own inline
   * `<svg>` paths, and a directory-load error reads through `ErrorNotice`
   * instead of a bare `<p role="alert">`. `icon-paths.ts` (issue #457) has
   * no dedicated `symlink` glyph yet, so a symlink row reuses `file` until
   * one is added — out of this issue's file scope (see the PR description).
   * The root `data-testid="file-tree-panel"`, every row/loading/error
   * `data-testid`, and the recursive expand/select behavior are all
   * unchanged.
   *
   * Bounded wait + retry (issue #582): `tree`'s `FileTreeDirectoryState` has
   * no timeout of its own — `RelayClient.expandDirectory`'s underlying
   * `fs_list_request` can sit `'loading'` forever against a node that never
   * answers, indistinguishable from one that is merely slow. This panel
   * owns its own bounded wait per path (`DIRECTORY_TIMEOUT_MS`, matching
   * every other RelayClient request default), decoupled from `tree`'s own
   * status: a path still `'loading'` when its timer fires gets this
   * panel's own retryable `ErrorNotice`, worded like `DirectoryPicker`'s
   * identical transport-timeout case (issue #505) — "may be asleep,
   * offline, or on an older relay" is the shell's established node-offline
   * phrasing, not a third one. Retry re-arms the timer AND calls
   * `onExpand` again (mirrors `expandDirectory`'s own doc comment: call it
   * again to re-fetch a path that came back `'error'`) rather than only
   * clearing the local flag. A path that resolves on its own before the
   * deadline (a slow-but-alive `'loaded'`/`'error'` landing late) clears
   * its timer and never shows this panel's own error at all.
   */
  import { onDestroy } from 'svelte';
  import type { FsEntryV1 } from '@loombox/protocol';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { joinTreePath, sortEntries } from '../file-tree';
  import type { FileTreeDirectoryState } from '../relay-client';
  import { Icon } from './icons';
  import WovenLoader from './WovenLoader.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';

  interface Props {
    tree: Map<string, FileTreeDirectoryState>;
    onExpand: (path: string) => void;
    /** Fired when the user clicks a file row — e.g. to open it, or to reuse this panel as a picker surface. Omit for a purely browsable, non-interactive-on-file tree. */
    onSelectFile?: (path: string) => void;
  }

  const { tree, onExpand, onSelectFile }: Props = $props();

  const expandedPaths = new SvelteSet<string>();

  /**
   * How long a directory may sit `'loading'` before this panel gives up
   * waiting on its own (issue #582) — `tree` carries no timeout of its
   * own. 10s matches every other request-shaped `RelayClient` default
   * (`browseDirectory`'s own `timeoutMs`), so a stated wait means the same
   * thing everywhere in the app.
   */
  const DIRECTORY_TIMEOUT_MS = 10_000;

  /** Paths whose own bounded wait (above) has elapsed while `tree` still reports them `'loading'` — rendered instead of (never alongside) the normal loading/error/loaded branches below, and cleared the instant `tree` reports anything else for that path. */
  let timedOutPaths = new SvelteSet<string>();
  /** One armed `setTimeout` per currently-`'loading'` path; cleared as soon as that path resolves (or times out) so a late real answer never fires a stale callback. */
  const pendingTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();

  function clearTimer(path: string): void {
    const timer = pendingTimers.get(path);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingTimers.delete(path);
  }

  function armTimer(path: string): void {
    if (pendingTimers.has(path)) return;
    pendingTimers.set(
      path,
      setTimeout(() => {
        pendingTimers.delete(path);
        timedOutPaths.add(path);
      }, DIRECTORY_TIMEOUT_MS),
    );
  }

  // Arms/disarms one timer per path every time a NEW `tree` snapshot
  // arrives (every `RelayClient` store update replaces the Map wholesale,
  // never mutates in place). Still `'loading'` and not yet timed out gets
  // a fresh timer; anything that resolved (`'loaded'`/`'error'`) —
  // including a slow-but-alive answer landing right under the deadline —
  // clears its timer and drops any stale timed-out flag, which is what
  // keeps a genuinely slow node from ever showing this panel's own error.
  $effect(() => {
    const seen = new SvelteSet<string>();
    for (const [path, state] of tree) {
      seen.add(path);
      if (state.status === 'loading') {
        if (!timedOutPaths.has(path)) armTimer(path);
      } else {
        clearTimer(path);
        timedOutPaths.delete(path);
      }
    }
    for (const path of [...pendingTimers.keys()]) {
      if (!seen.has(path)) clearTimer(path);
    }
    for (const path of [...timedOutPaths]) {
      if (!seen.has(path)) timedOutPaths.delete(path);
    }
  });

  onDestroy(() => {
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
  });

  /** Retry (issue #582): re-arms this path's own bounded wait AND calls `onExpand` again — never just clears the local flag, exactly like `expandDirectory`'s own doc comment describes retrying a directory that came back `'error'`. */
  function retryDirectory(path: string): void {
    timedOutPaths.delete(path);
    armTimer(path);
    onExpand(path);
  }

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
  {@const entries = entriesFor(path)}
  {#if timedOutPaths.has(path)}
    <div class="tree-error" data-testid="file-tree-error">
      <ErrorNotice
        message="This folder didn't answer in time. The node may be asleep, offline, or on an older relay."
        retryable
        onRetry={() => retryDirectory(path)}
      />
    </div>
  {:else if dirState?.status === 'loading'}
    <p class="tree-status tree-status-loading" data-testid="file-tree-loading">
      <WovenLoader size="sm" label="Loading directory" />
      Loading…
    </p>
  {:else if dirState?.status === 'error'}
    <div class="tree-error" data-testid="file-tree-error">
      <ErrorNotice message={dirState.error ?? 'Failed to load this directory.'} />
    </div>
  {:else if dirState?.status === 'loaded' && entries.length === 0}
    <EmptyState
      message={path === '' ? 'This project has no files yet.' : 'This directory is empty.'}
    />
  {/if}
  {#if !(dirState?.status === 'loaded' && entries.length === 0)}
    <ul class="tree-entries">
      {#each entries as entry (entry.name)}
        {@const entryPath = joinTreePath(path, entry.name)}
        <li>
          {#if entry.kind === 'dir'}
            <button
              type="button"
              class="tree-row tree-row-dir"
              onclick={() => toggle(entryPath)}
              aria-expanded={expandedPaths.has(entryPath)}
              data-testid="file-tree-dir"
            >
              <span
                class="tree-chevron"
                class:tree-chevron-open={expandedPaths.has(entryPath)}
                aria-hidden="true"
              >
                <Icon name="collapse-chevron" size="100%" />
              </span>
              <span class="tree-icon" aria-hidden="true">
                <Icon name="folder" size="100%" />
              </span>
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
              class="tree-row tree-row-file"
              onclick={() => onSelectFile?.(entryPath)}
              data-testid="file-tree-file"
            >
              <span class="tree-icon" aria-hidden="true">
                <Icon name="file" size="100%" />
              </span>
              <span class="name">{entry.name}</span>
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
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
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
    padding: var(--space-2xs) var(--space-xs);
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .tree-error {
    padding: var(--space-2xs) 0;
  }

  .tree-entries {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* A newly expanded directory's rows read as a list appearing (redesign
     brief §2's "beat-in" job): a quiet 4px slide + fade, driven entirely by
     `--duration-*`/`--ease-beat` so `prefers-reduced-motion` (which zeroes
     every `--duration-*` token in `tokens.css`) collapses it for free. */
  .tree-children {
    animation: tree-reveal var(--duration-base) var(--ease-beat);
  }

  .tree-children .tree-entries {
    padding-left: var(--space-lg);
    border-left: 1px solid var(--color-border-subtle);
    margin-left: var(--space-sm);
  }

  @keyframes tree-reveal {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .tree-row {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    width: 100%;
    border: none;
    background: transparent;
    color: var(--color-text-primary);
    text-align: left;
    padding: var(--space-2xs) var(--space-xs);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font: inherit;
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .tree-row:hover {
    background: var(--color-fill-subtle);
  }

  .tree-row:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: -2px;
  }

  .tree-chevron,
  .tree-icon {
    display: inline-flex;
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
    color: var(--color-text-muted);
  }

  /* A quiet rotation, not thread-draw: thread-draw is reserved for
     fills/reveals (redesign brief §2 table), and a disclosure toggle is
     neither — it's a symmetric state flip, `status-crossfade`'s family of
     job. */
  .tree-chevron {
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  .tree-chevron-open {
    transform: rotate(90deg);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
