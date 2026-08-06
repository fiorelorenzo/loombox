<script lang="ts">
  /**
   * The `@file` reference picker (SPEC §7.25 "@file references"; issue
   * #160), backed by the exact same file-tree data `FileTreePanel.svelte`
   * renders (`RelayClient.fileTreeFor`/`expandDirectory`, SPEC §7.4; issue
   * #171) — selecting a row inserts a `@path` reference into the composer,
   * costing nothing beyond the reference itself (no upload/encryption round
   * trip: the agent reads its own filesystem directly). Fuzzy-filters over
   * every FILE currently known across the tree (`$lib/file-tree.ts`'s
   * `flattenLoadedFiles`), using the same hand-rolled matcher
   * `CommandPalette.svelte` already uses (`$lib/fuzzy.ts`) — same
   * arrow-key/Enter/Esc handling too, so the two pickers behave identically.
   *
   * "Currently known" would otherwise mean only the root, since SPEC §7.4's
   * lazy-expand contract only loads a directory once the tree panel expands
   * it — a poor search corpus for a picker whose whole point is finding a
   * file without having clicked through to it first. So this component
   * opportunistically walks every directory it can already see but hasn't
   * loaded yet (bounded by `MAX_AUTO_EXPAND`, since an unbounded walk on a
   * huge repo would fire hundreds of `fs_list_request`s at once): each
   * directory still goes through the ordinary lazy per-directory request,
   * just triggered by this picker opening instead of a manual click, and it
   * naturally converges (or stops at the cap) as loads land and reveal
   * further subdirectories.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §4,
   * issue #431): hand-rolled backdrop+card chrome moves onto the shared
   * `Dialog` primitive, mirroring `CommandPalette.svelte`'s identical
   * migration — same tight-row/fast-hover visual language, same
   * stop-propagation note on Esc (this component owns its own Esc/arrow
   * handling on the search input; without it Dialog's own Esc handler
   * would fire a second `onClose`).
   *
   * Deck migration (redesign v2, issue #467): each result row's file glyph
   * now draws from the shared bespoke `Icon` component (`./icons`) instead
   * of this component's own inline `<svg>`, and the "no matches" row reads
   * through `EmptyState` instead of a plain `<li>`.
   */
  import { fuzzyFilter } from '../fuzzy';
  import { flattenLoadedFiles, joinTreePath, type FlatFileEntry } from '../file-tree';
  import type { FileTreeDirectoryState } from '../relay-client';
  import { Icon } from './icons';
  import Dialog from './ui/Dialog.svelte';
  import EmptyState from './ui/EmptyState.svelte';

  interface Props {
    open: boolean;
    tree: Map<string, FileTreeDirectoryState>;
    onExpand: (path: string) => void;
    onSelect: (path: string) => void;
    onClose: () => void;
  }

  const { open, tree, onExpand, onSelect, onClose }: Props = $props();

  /** Per-open cap on how many not-yet-loaded directories this picker will auto-expand — see this component's own doc comment. */
  const MAX_AUTO_EXPAND = 200;

  let query = $state('');
  let activeIndex = $state(0);
  let autoExpandedCount = 0;

  const files = $derived(flattenLoadedFiles(tree));
  const results = $derived(fuzzyFilter(files, query, (entry) => entry.path));

  $effect(() => {
    if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
  });

  $effect(() => {
    if (open) {
      query = '';
      activeIndex = 0;
      autoExpandedCount = 0;
    }
  });

  // The opportunistic "walk what's reachable" pass described above — reruns
  // whenever `tree` gains a newly-loaded directory (a fresh Map reference
  // from `RelayClient`), so each wave of loads can reveal, and then queue,
  // the next one, until everything reachable (or the cap) is hit.
  $effect(() => {
    if (!open) return;
    for (const dir of tree.values()) {
      if (dir.status !== 'loaded') continue;
      for (const entry of dir.entries) {
        if (entry.kind !== 'dir') continue;
        const path = joinTreePath(dir.path, entry.name);
        if (tree.has(path)) continue;
        if (autoExpandedCount >= MAX_AUTO_EXPAND) return;
        autoExpandedCount += 1;
        onExpand(path);
      }
    }
  });

  function activate(entry: FlatFileEntry): void {
    onSelect(entry.path);
    onClose();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // Stop here rather than let it bubble to Dialog's own Esc handler —
      // both would otherwise call onClose for the same keypress.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = results.length === 0 ? 0 : (activeIndex + 1) % results.length;
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = results.length === 0 ? 0 : (activeIndex - 1 + results.length) % results.length;
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const entry = results[activeIndex];
      if (entry) activate(entry);
    }
  }
</script>

{#snippet pickerHeader()}
  <input
    type="text"
    class="picker-input"
    placeholder="Reference a file…"
    aria-label="File reference search"
    bind:value={query}
    onkeydown={handleKeydown}
    data-testid="file-reference-picker-input"
  />
{/snippet}

{#snippet pickerBody()}
  {#if results.length === 0}
    <EmptyState message="No matching files." />
  {:else}
    <ul class="picker-results" role="listbox">
      {#each results as entry, index (entry.path)}
        <li>
          <button
            type="button"
            class="picker-item"
            class:active={index === activeIndex}
            role="option"
            aria-selected={index === activeIndex}
            onmouseenter={() => (activeIndex = index)}
            onclick={() => activate(entry)}
            data-testid="file-reference-picker-item"
          >
            <span class="entry-icon" aria-hidden="true">
              <Icon name="file" size="100%" />
            </span>
            <span class="path font-mono">{entry.path}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#snippet pickerFooter()}
  <div class="picker-hints">
    <span>↑↓ navigate</span>
    <span>Enter insert</span>
    <span>Esc close</span>
  </div>
{/snippet}

<Dialog
  {open}
  label="Reference a file"
  {onClose}
  size="md"
  class="file-reference-picker-panel"
  header={pickerHeader}
  children={pickerBody}
  footer={pickerFooter}
/>

<style>
  :global(.file-reference-picker-panel) {
    width: min(30rem, 92vw);
    max-height: 60vh;
  }

  .picker-input {
    padding: var(--space-sm) var(--space-3xs);
    border: none;
    border-bottom: 1px solid var(--color-border);
    font-size: var(--text-body-size);
    background: transparent;
    color: inherit;
    font-family: inherit;
  }

  .picker-input::placeholder {
    color: var(--color-text-muted);
  }

  .picker-input:focus {
    outline: none;
  }

  .picker-results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
  }

  .picker-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    text-align: left;
    border: none;
    border-left: 2px solid transparent;
    background: transparent;
    color: inherit;
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: var(--text-small-size);
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat);
  }

  .picker-item:not(:disabled):active {
    transform: scale(0.995);
  }

  .picker-item.active {
    background: var(--color-accent-subtle);
    border-left-color: var(--color-accent);
  }

  .entry-icon {
    flex-shrink: 0;
    display: inline-flex;
    width: 1rem;
    height: 1rem;
    color: var(--color-text-secondary);
  }

  .picker-item.active .entry-icon {
    color: var(--color-accent);
  }

  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }

  .picker-hints {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-md);
    font-size: var(--text-caption-size);
    color: var(--color-text-muted);
  }
</style>
