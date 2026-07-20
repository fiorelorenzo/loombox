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
   */
  import { fuzzyFilter } from '$lib/fuzzy';

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
  let inputEl = $state<HTMLInputElement | undefined>(undefined);

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

  $effect(() => {
    if (open) {
      query = '';
      activeIndex = 0;
      inputEl?.focus();
    }
  });

  function activate(entry: Entry): void {
    if (entry.kind === 'session') onSelectSession(entry.session.id);
    else entry.action.run();
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
    class="palette-backdrop"
    role="presentation"
    onclick={onClose}
    data-testid="command-palette-backdrop"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="palette"
      role="dialog"
      tabindex="-1"
      aria-label="Command palette"
      onclick={(event) => event.stopPropagation()}
      data-testid="command-palette"
    >
      <input
        bind:this={inputEl}
        type="text"
        class="palette-input"
        placeholder="Jump to a session or run an action…"
        aria-label="Command palette search"
        bind:value={query}
        onkeydown={handleKeydown}
        data-testid="command-palette-input"
      />

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
              <span class="kind">{entry.kind === 'session' ? 'Session' : 'Action'}</span>
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

      <div class="palette-hints">
        <span>↑↓ navigate</span>
        <span>Enter select</span>
        <span>Esc close</span>
        {#each actions.filter((a) => a.shortcut) as action (action.id)}
          <span>{action.shortcut} {action.label}</span>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
    z-index: 50;
  }

  .palette {
    width: min(32rem, 90vw);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    border-radius: 0.6rem;
    background: canvas;
    color: canvastext;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }

  .palette-input {
    padding: 0.75rem 0.9rem;
    border: none;
    border-bottom: 1px solid rgba(127, 127, 127, 0.25);
    font-size: 1rem;
    background: transparent;
    color: inherit;
  }

  .palette-input:focus {
    outline: none;
  }

  .palette-results {
    list-style: none;
    margin: 0;
    padding: 0.3rem;
    overflow-y: auto;
    flex: 1;
  }

  .palette-empty {
    padding: 0.6rem;
    opacity: 0.6;
    font-size: 0.85rem;
  }

  .palette-item {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    text-align: left;
    border: none;
    background: transparent;
    color: inherit;
    padding: 0.45rem 0.6rem;
    border-radius: 0.4rem;
    cursor: pointer;
  }

  .palette-item.active {
    background: rgba(79, 70, 229, 0.18);
  }

  .kind {
    flex-shrink: 0;
    font-size: 0.65rem;
    text-transform: uppercase;
    opacity: 0.55;
  }

  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    flex-shrink: 0;
    font-size: 0.75rem;
    opacity: 0.55;
  }

  .palette-hints {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    padding: 0.5rem 0.9rem;
    border-top: 1px solid rgba(127, 127, 127, 0.2);
    font-size: 0.7rem;
    opacity: 0.6;
  }
</style>
