<script lang="ts">
  /**
   * The fuzzy jump-to-session/project quick-switcher plus a discoverable
   * shortcut list (SPEC.md §7.3 "Keyboard & command palette are a
   * cross-cutting requirement: a fuzzy jump-to-session/project
   * quick-switcher plus shortcuts for the common actions"; issue #132).
   * Never a blocking modal for the *rest* of the app's own concerns (the
   * transcript keeps running underneath) — it's a focused overlay, closed
   * by Esc or picking an entry, mirroring the permission card's own
   * never-block-other-sessions philosophy (SPEC.md §7.24).
   *
   * Sessions and actions are fuzzy-filtered together (`$lib/fuzzy.ts`,
   * hand-rolled, no new dependency) against one query, sorted best match
   * first; an empty query shows every entry so the palette also works as a
   * plain browsable list, not only a search box. Arrow keys move the
   * active row, Enter activates it, Esc closes without acting — the exact
   * same defer-vs-resolve split `PermissionCard`'s own keyboard handling
   * uses (issue #148).
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §4/§6,
   * issue #431): the hand-rolled backdrop+card chrome is replaced by the
   * shared `Dialog` primitive (`thread-lift` entrance, Esc/backdrop-click/
   * focus-trap all come from there now — this component no longer owns
   * any of that). Rows get leading icon-set glyphs (session vs. action)
   * in place of the old text-only "Session"/"Action" tags, kept
   * screen-reader-visible via a `.sr-only` label so removing the visible
   * tag loses no accessible information. Tight, single-line rows and a
   * fast hover/active crossfade are the "Raycast-grade" feel the brief's
   * surface direction calls for; the active row reads as a 2px accent
   * left-bar + subtle tint (accent-for-meaning, never a filled block),
   * echoing the session-row convention documented in the brief's §4.
   *
   * Deck migration (redesign v2 §2 "Icon system", issue #472): the two
   * inline, one-off SVG glyphs above are replaced by the shared bespoke
   * `Icon` component (`sessions` for a session row, `command` — the
   * physical ⌘-key glyph, apt for a command-palette action row — for an
   * action row), so the palette's rows draw from the same hand-drawn set
   * as everywhere else instead of maintaining their own stroke paths.
   */
  import { fuzzyFilter } from '$lib/fuzzy';
  import Icon from './icons/Icon.svelte';
  import Dialog from './ui/Dialog.svelte';

  export interface CommandPaletteSession {
    id: string;
    title: string;
    projectPath: string;
  }

  export interface CommandPaletteAction {
    id: string;
    label: string;
    shortcut?: string;
    run: () => void;
  }

  interface Props {
    open: boolean;
    sessions: CommandPaletteSession[];
    actions?: CommandPaletteAction[];
    onSelectSession: (id: string) => void;
    onClose: () => void;
  }

  const { open, sessions, actions = [], onSelectSession, onClose }: Props = $props();

  type Entry =
    | { kind: 'session'; id: string; text: string; session: CommandPaletteSession }
    | { kind: 'action'; id: string; text: string; action: CommandPaletteAction };

  let query = $state('');
  let activeIndex = $state(0);

  const allEntries = $derived<Entry[]>([
    ...actions.map((action): Entry => ({
      kind: 'action',
      id: action.id,
      text: action.label,
      action,
    })),
    ...sessions.map((session): Entry => ({
      kind: 'session',
      id: session.id,
      text: `${session.title} ${session.projectPath}`,
      session,
    })),
  ]);

  const results = $derived(fuzzyFilter(allEntries, query, (entry) => entry.text));

  // Re-clamps the active row whenever the filtered list changes shape (a
  // keystroke can shrink it out from under whatever index was active).
  $effect(() => {
    if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
  });

  // Resets the search on every open — focusing the input is now the
  // shared `Dialog`'s job (its focus-trap moves focus to the first
  // focusable element, which is this header's search input).
  $effect(() => {
    if (open) {
      query = '';
      activeIndex = 0;
    }
  });

  function activate(entry: Entry): void {
    if (entry.kind === 'session') onSelectSession(entry.session.id);
    else entry.action.run();
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

{#snippet paletteHeader()}
  <input
    type="text"
    class="palette-input"
    placeholder="Jump to a session or run an action…"
    aria-label="Command palette search"
    bind:value={query}
    onkeydown={handleKeydown}
    data-testid="command-palette-input"
  />
{/snippet}

{#snippet paletteBody()}
  <ul class="palette-results" role="listbox">
    {#if results.length === 0}
      <li class="palette-empty">No matches.</li>
    {/if}
    {#each results as entry, index (entry.kind + ':' + entry.id)}
      <li>
        <button
          type="button"
          class="palette-item"
          class:active={index === activeIndex}
          role="option"
          aria-selected={index === activeIndex}
          onmouseenter={() => (activeIndex = index)}
          onclick={() => activate(entry)}
          data-testid="command-palette-item"
        >
          {#if entry.kind === 'session'}
            <Icon name="sessions" class="entry-icon" />
          {:else}
            <Icon name="command" class="entry-icon" />
          {/if}
          <span class="sr-only">{entry.kind === 'session' ? 'Session' : 'Action'}</span>
          {#if entry.kind === 'session'}
            <span class="label">{entry.session.title}</span>
            <span class="meta">{entry.session.projectPath}</span>
          {:else}
            <span class="label">{entry.action.label}</span>
            {#if entry.action.shortcut}
              <span class="meta">{entry.action.shortcut}</span>
            {/if}
          {/if}
        </button>
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet paletteFooter()}
  <div class="palette-hints">
    <span>↑↓ navigate</span>
    <span>Enter select</span>
    <span>Esc close</span>
    {#each actions.filter((a) => a.shortcut) as action (action.id)}
      <span>{action.shortcut} {action.label}</span>
    {/each}
  </div>
{/snippet}

<Dialog
  {open}
  label="Command palette"
  {onClose}
  size="md"
  class="command-palette-panel"
  header={paletteHeader}
  children={paletteBody}
  footer={paletteFooter}
/>

<style>
  /* Overrides the shared Dialog panel's own box (its default padding/max-
     width are tuned for a form dialog, not a dense, wide result list) —
     the documented escape hatch for the `class` prop Dialog's own doc
     comment calls out. */
  :global(.command-palette-panel) {
    width: min(34rem, 92vw);
    max-height: 70vh;
  }

  .palette-input {
    padding: var(--space-sm) 0.15rem;
    border: none;
    border-bottom: 1px solid var(--color-border);
    font-size: 1rem;
    background: transparent;
    color: inherit;
    font-family: inherit;
  }

  .palette-input::placeholder {
    color: var(--color-text-muted);
  }

  .palette-input:focus {
    outline: none;
  }

  .palette-results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
  }

  .palette-empty {
    padding: var(--space-sm) var(--space-2xs);
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }

  /* Tight, single-line rows — the "Raycast-grade" density the brief's
     surface direction asks for. */
  .palette-item {
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
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat);
  }

  .palette-item:not(:disabled):active {
    transform: scale(0.995);
  }

  /* Active row: a 2px accent left-bar + subtle tint — never a filled
     accent block (redesign brief §4's "accent-for-meaning" row
     convention). */
  .palette-item.active {
    background: var(--color-accent-subtle);
    border-left-color: var(--color-accent);
  }

  /* `:global` — the `entry-icon` class lands on the `<svg>` `Icon.svelte`
     (a child component) renders, which carries `Icon`'s own scope hash,
     not this file's, so a plain (non-`:global`) selector would never
     match (same rationale `+page.svelte`'s `.rail-icon` documents). */
  :global(.entry-icon) {
    flex-shrink: 0;
    width: 1.125rem;
    height: 1.125rem;
    color: var(--color-text-secondary);
  }

  .palette-item.active :global(.entry-icon) {
    color: var(--color-accent);
  }

  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-body-size);
  }

  .meta {
    flex-shrink: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
  }

  .palette-hints {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-md);
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
