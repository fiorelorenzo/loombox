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
   */
  import { fuzzyFilter } from '../fuzzy';
  import { flattenLoadedFiles, joinTreePath, type FlatFileEntry } from '../file-tree';
  import type { FileTreeDirectoryState } from '../relay-client';

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
  let inputEl = $state<HTMLInputElement | undefined>(undefined);
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
      inputEl?.focus();
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
      event.preventDefault();
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

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="picker-backdrop"
    role="presentation"
    onclick={onClose}
    data-testid="file-reference-picker-backdrop"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="picker"
      role="dialog"
      tabindex="-1"
      aria-label="Reference a file"
      onclick={(event) => event.stopPropagation()}
      data-testid="file-reference-picker"
    >
      <input
        bind:this={inputEl}
        type="text"
        class="picker-input"
        placeholder="Reference a file…"
        aria-label="File reference search"
        bind:value={query}
        onkeydown={handleKeydown}
        data-testid="file-reference-picker-input"
      />

      <ul class="picker-results" role="listbox">
        {#if results.length === 0}
          <li class="picker-empty">No matching files.</li>
        {/if}
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
              <span class="path">{entry.path}</span>
            </button>
          </li>
        {/each}
      </ul>

      <div class="picker-hints">
        <span>↑↓ navigate</span>
        <span>Enter insert</span>
        <span>Esc close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .picker-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    z-index: 60;
  }

  .picker {
    width: min(28rem, 90vw);
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    border-radius: 0.6rem;
    background: canvas;
    color: canvastext;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }

  .picker-input {
    padding: 0.65rem 0.8rem;
    border: none;
    border-bottom: 1px solid rgba(127, 127, 127, 0.25);
    font-size: 0.95rem;
    background: transparent;
    color: inherit;
  }

  .picker-input:focus {
    outline: none;
  }

  .picker-results {
    list-style: none;
    margin: 0;
    padding: 0.3rem;
    overflow-y: auto;
    flex: 1;
  }

  .picker-empty {
    padding: 0.5rem;
    opacity: 0.6;
    font-size: 0.8rem;
  }

  .picker-item {
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    color: inherit;
    padding: 0.4rem 0.55rem;
    border-radius: 0.35rem;
    cursor: pointer;
    font-size: 0.82rem;
  }

  .picker-item.active {
    background: rgba(79, 70, 229, 0.18);
  }

  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .picker-hints {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
    padding: 0.4rem 0.8rem;
    border-top: 1px solid rgba(127, 127, 127, 0.2);
    font-size: 0.68rem;
    opacity: 0.6;
  }
</style>
