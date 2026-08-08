<script lang="ts">
  /**
   * The `/`-command picker (Zed-parity decision C2-4, `docs/superpowers/
   * specs/2026-08-05-zed-parity-decisions.md` §3 "C2-3 and C2-4"; issue
   * #743), backed by exactly what the connected agent declared —
   * `RelayClient.commandsFor(sessionId)`, fed end to end by issue #741's
   * `available_commands_update` plumbing. There is deliberately no
   * hardcoded loombox command list anywhere in this component: `commands`
   * is the agent's own catalog, verbatim, and an agent that has declared
   * none renders this component to an empty result set (no placeholder
   * rows) — the composer's own trigger logic (`+page.svelte`'s
   * `handleComposerInput`) goes one step further and never opens this
   * picker at all when `commands` is empty, so `/` truly does nothing.
   *
   * Selecting a row inserts `/name ` into the composer and sends it as an
   * ordinary prompt on submit — never a special RPC. Argument shape, where
   * a command declares one (`input.hint`, e.g. `[on|off|status]`), is
   * shown alongside the row as a hint only; it is never parsed, validated,
   * or inserted as literal text, since the value itself is whatever the
   * user types next, in the form the agent itself described, not a
   * loombox-invented schema.
   *
   * Same modal-picker shape as `FileReferencePicker.svelte` (`@file`,
   * issue #160) on purpose — `Dialog`, hand-rolled `fuzzyFilter`
   * (`$lib/fuzzy.ts`), identical arrow-key/Enter/Esc handling — so the two
   * pickers behave identically and neither reinvents keyboard nav. Because
   * `commands` is a plain reactive prop (the caller's own
   * `client.commandsFor(sessionId)` subscription), a mid-session
   * `available_commands_update` re-render this picker's results without
   * anything here re-subscribing or reloading.
   */
  import { fuzzyFilter } from '../fuzzy';
  import type { AcpAvailableCommand } from '@loombox/providers-core/browser';
  import { Icon } from './icons';
  import Dialog from './ui/Dialog.svelte';
  import EmptyState from './ui/EmptyState.svelte';

  interface Props {
    open: boolean;
    commands: AcpAvailableCommand[];
    onSelect: (command: AcpAvailableCommand) => void;
    onClose: () => void;
  }

  const { open, commands, onSelect, onClose }: Props = $props();

  let query = $state('');
  let activeIndex = $state(0);

  const results = $derived(
    fuzzyFilter(commands, query, (entry) =>
      entry.description ? `${entry.name} ${entry.description}` : entry.name,
    ),
  );

  $effect(() => {
    if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
  });

  $effect(() => {
    if (open) {
      query = '';
      activeIndex = 0;
    }
  });

  function activate(entry: AcpAvailableCommand): void {
    onSelect(entry);
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
    placeholder="Run a command…"
    aria-label="Slash command search"
    bind:value={query}
    onkeydown={handleKeydown}
    data-testid="slash-command-picker-input"
  />
{/snippet}

{#snippet pickerBody()}
  {#if results.length === 0}
    <EmptyState message="No matching commands." />
  {:else}
    <ul class="picker-results" role="listbox">
      {#each results as entry, index (entry.name)}
        <li>
          <button
            type="button"
            class="picker-item"
            class:active={index === activeIndex}
            role="option"
            aria-selected={index === activeIndex}
            onmouseenter={() => (activeIndex = index)}
            onclick={() => activate(entry)}
            data-testid="slash-command-picker-item"
          >
            <span class="entry-icon" aria-hidden="true">
              <Icon name="command" size="100%" />
            </span>
            <span class="entry-body">
              <span class="name">/{entry.name}</span>
              {#if entry.mcpServer}
                <span class="description">MCP prompt from {entry.mcpServer}</span>
              {:else if entry.description}
                <span class="description">{entry.description}</span>
              {/if}
            </span>
            {#if entry.input?.hint}
              <span class="hint">{entry.input.hint}</span>
            {/if}
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
  label="Run a command"
  {onClose}
  size="md"
  class="slash-command-picker-panel"
  header={pickerHeader}
  children={pickerBody}
  footer={pickerFooter}
/>

<style>
  :global(.slash-command-picker-panel) {
    width: var(--dialog-width-sm);
    max-height: var(--dialog-max-height);
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

  .entry-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: var(--space-3xs);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }

  .description {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-caption-size);
    color: var(--color-text-secondary);
  }

  .hint {
    flex-shrink: 0;
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-caption-size);
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .picker-hints {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-md);
    font-size: var(--text-caption-size);
    color: var(--color-text-muted);
  }
</style>
