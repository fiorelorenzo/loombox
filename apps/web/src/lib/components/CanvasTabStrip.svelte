<script lang="ts">
  /**
   * The canvas tab strip (issue #737, settled pick B2-2 in
   * `docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §2): the
   * session transcript is a permanent, non-closable tab pinned first —
   * enforced structurally by `$lib/tabs.svelte.ts`'s `CanvasTabsState`
   * (it never appends before index 0 and `close('transcript')` is a
   * no-op), not by any UI-level guard here — and anything opened from the
   * Files panel tree, an `@`-mention pill, or a diff card's own "open"
   * affordance renders beside it as a real closable tab.
   *
   * Narrow behaviour (issue #737's own acceptance line — "not optional,
   * decide it and write it down"): below `TABLET_VIEWPORT_BREAKPOINT_PX`
   * a horizontal strip has nowhere to go. The pick here is "a single
   * active tab plus a picker" (the decisions doc's own first option,
   * `2026-08-05-zed-parity-decisions.md` §2's B2-2 trade sentence) over
   * "no tabs at all": a file opened from a diff card on a phone still
   * needs a way back to the transcript, and a picker is the smallest
   * control that keeps every tab reachable in one compact row rather than
   * a horizontal scroller fighting the phone's own edge-swipe gestures
   * (design spec's SPEC §7.3 "narrow-viewport" precedent — a scrollable
   * list, never a scrollable strip, at this width). The active tab's own
   * name/icon/dirty dot render inline; a `chevron-down` button opens a
   * `Dialog`-backed list of every open tab to switch among, and the
   * active tab's own close button (when it's a file, never the
   * transcript) stays inline too so closing never requires opening the
   * picker first.
   */
  import { Icon, type IconName } from './icons';
  import type { CanvasTab, DiffCanvasTab, FileCanvasTab, GraphCanvasTab } from '$lib/tabs.svelte';
  import Dialog from './ui/Dialog.svelte';
  import IconButton from './ui/IconButton.svelte';

  interface Props {
    tabs: readonly CanvasTab[];
    activeId: string;
    isDirty: (path: string) => boolean;
    onActivate: (id: string) => void;
    onClose: (id: string) => void;
    /** Below `TABLET_VIEWPORT_BREAKPOINT_PX` — see the file doc comment for the picker this switches to. */
    narrow: boolean;
    /** Forwarded to the narrow picker's own `Dialog` — see that primitive's identical prop for the reduced-motion/test-determinism reasoning. */
    reducedMotion?: boolean;
  }

  const {
    tabs,
    activeId,
    isDirty,
    onActivate,
    onClose,
    narrow,
    reducedMotion = false,
  }: Props = $props();

  function tabLabel(tab: CanvasTab): string {
    if (tab.kind === 'transcript') return 'Session';
    if (tab.kind === 'diff') return 'Working tree';
    if (tab.kind === 'graph') return 'Commit graph';
    return tab.name;
  }

  function tabIcon(tab: CanvasTab): IconName {
    if (tab.kind === 'transcript') return 'sessions';
    if (tab.kind === 'diff') return 'tool-edit';
    if (tab.kind === 'graph') return 'git-graph';
    return 'file';
  }

  /** Every non-transcript tab is closable (a file tab, or a singleton diff/graph tab) — this label is the close button's own accessible name for whichever one it is. */
  function closeLabel(tab: FileCanvasTab | DiffCanvasTab | GraphCanvasTab): string {
    if (tab.kind === 'diff') return 'Close working tree diff';
    if (tab.kind === 'graph') return 'Close commit graph';
    return `Close ${tab.name}`;
  }

  const activeTab = $derived(tabs.find((tab) => tab.id === activeId) ?? tabs[0]);

  let pickerOpen = $state(false);

  function openPicker(): void {
    pickerOpen = true;
  }

  function closePicker(): void {
    pickerOpen = false;
  }

  function pick(id: string): void {
    onActivate(id);
    closePicker();
  }
</script>

{#if narrow}
  <div class="canvas-tab-strip canvas-tab-strip-narrow" data-testid="canvas-tab-strip">
    {#if activeTab}
      <button
        type="button"
        class="canvas-tab-narrow-current"
        onclick={openPicker}
        data-testid="canvas-tab-strip-picker-trigger"
      >
        <Icon name={tabIcon(activeTab)} size="14px" />
        <span class="canvas-tab-label">{tabLabel(activeTab)}</span>
        {#if activeTab.kind === 'file' && isDirty(activeTab.path)}
          <span class="canvas-tab-dirty-dot" data-testid="canvas-tab-dirty-dot" aria-hidden="true"
          ></span>
        {/if}
        <Icon name="chevron-down" size="12px" />
      </button>
      {#if activeTab.kind !== 'transcript'}
        <IconButton
          label={closeLabel(activeTab)}
          size="sm"
          onclick={() => onClose(activeTab.id)}
          dataTestId="canvas-tab-strip-close-active"
        >
          <Icon name="close" size="12px" />
        </IconButton>
      {/if}
    {/if}

    {#snippet pickerHeader()}
      <h2>Switch tab</h2>
    {/snippet}
    {#snippet pickerBody()}
      <ul class="canvas-tab-picker-list" data-testid="canvas-tab-picker-list">
        {#each tabs as tab (tab.id)}
          <li>
            <button
              type="button"
              class="canvas-tab-picker-item"
              class:active={tab.id === activeId}
              onclick={() => pick(tab.id)}
              data-testid="canvas-tab-picker-item"
            >
              <Icon name={tabIcon(tab)} size="14px" />
              <span class="canvas-tab-label">{tabLabel(tab)}</span>
              {#if tab.kind === 'file' && isDirty(tab.path)}
                <span
                  class="canvas-tab-dirty-dot"
                  data-testid="canvas-tab-dirty-dot"
                  aria-hidden="true"
                ></span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/snippet}
    <Dialog
      open={pickerOpen}
      label="Switch tab"
      onClose={closePicker}
      size="sm"
      header={pickerHeader}
      children={pickerBody}
      {reducedMotion}
    />
  </div>
{:else}
  <div
    class="canvas-tab-strip"
    role="tablist"
    aria-label="Canvas tabs"
    data-testid="canvas-tab-strip"
  >
    {#each tabs as tab (tab.id)}
      <div class="canvas-tab" class:active={tab.id === activeId} data-testid="canvas-tab">
        <button
          type="button"
          class="canvas-tab-activate"
          role="tab"
          aria-selected={tab.id === activeId}
          onclick={() => onActivate(tab.id)}
          data-testid="canvas-tab-activate"
        >
          <Icon name={tabIcon(tab)} size="14px" />
          <span class="canvas-tab-label">{tabLabel(tab)}</span>
          {#if tab.kind === 'file' && isDirty(tab.path)}
            <span class="canvas-tab-dirty-dot" data-testid="canvas-tab-dirty-dot" aria-hidden="true"
            ></span>
          {/if}
        </button>
        {#if tab.kind !== 'transcript'}
          <IconButton
            label={closeLabel(tab)}
            size="sm"
            onclick={() => onClose(tab.id)}
            dataTestId="canvas-tab-close"
          >
            <Icon name="close" size="12px" />
          </IconButton>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .canvas-tab-strip {
    display: flex;
    align-items: center;
    gap: var(--space-3xs);
    padding: var(--space-2xs) var(--space-sm) 0;
    border-bottom: 1px solid var(--color-border-subtle);
    overflow-x: auto;
  }

  .canvas-tab-strip-narrow {
    justify-content: space-between;
    padding-bottom: var(--space-2xs);
    overflow-x: visible;
  }

  .canvas-tab {
    display: flex;
    align-items: center;
    gap: var(--space-3xs);
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    padding-inline-end: var(--space-3xs);
    color: var(--color-text-secondary);
  }

  .canvas-tab.active {
    background: var(--color-surface-raised);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border-subtle);
    border-bottom-color: transparent;
    margin-bottom: -1px;
  }

  .canvas-tab-activate,
  .canvas-tab-narrow-current,
  .canvas-tab-picker-item {
    display: flex;
    align-items: center;
    gap: var(--space-3xs);
    padding: var(--space-2xs) var(--space-sm);
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  .canvas-tab-narrow-current {
    flex: 1;
    min-width: 0;
    justify-content: flex-start;
  }

  .canvas-tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 12rem;
  }

  .canvas-tab-dirty-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-accent);
    flex-shrink: 0;
  }

  .canvas-tab-picker-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .canvas-tab-picker-item {
    width: 100%;
    border-radius: var(--radius-md);
  }

  .canvas-tab-picker-item.active {
    background: var(--color-fill-subtle);
    color: var(--color-text-primary);
  }
</style>
