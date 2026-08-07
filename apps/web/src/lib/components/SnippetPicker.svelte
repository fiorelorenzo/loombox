<script lang="ts">
  /**
   * The reusable prompt/snippet library's picker (SPEC §7.18; issue #261,
   * epic #29): browse, search, insert, save, and delete the account's
   * saved snippet catalog from any session's composer.
   *
   * Genuinely distinct from every other composer mechanism it sits next
   * to, not a fourth parallel one — see `@loombox/protocol`'s `snippet.ts`
   * doc comment for the full "why not fold this into templates/slash
   * commands/mentions" reasoning. In short: `SessionTemplateV1` (issue
   * #259) has no field for arbitrary prompt text at all; the `/`-command
   * picker is the agent's own declared catalogue, never persisted or
   * user-authored; `@`-mentions resolve to a live reference rendered as a
   * pill, never literal text. A snippet is the plain, user-authored,
   * persisted case none of the three cover: insert `text` verbatim into
   * the draft, byte for byte.
   *
   * Same modal-picker shape as `SlashCommandPicker.svelte` on purpose —
   * `Dialog`, hand-rolled `fuzzyFilter` (`$lib/fuzzy.ts`), identical
   * arrow-key/Enter/Esc navigation — plus a "+ Save current draft as
   * snippet" toggle+form, mirroring `NewSessionDialog.svelte`'s own
   * "+ Save as template" section exactly (same toggle-reveals-a-form
   * shape, same `Field`+`Input`+`TextArea`+`ErrorNotice` composition).
   *
   * `onSave`/`onDelete` are plain callbacks, not a client dependency: the
   * caller (`+page.svelte`) owns `RelayClient.saveSnippets`'s full-catalog
   * "whole value, never a partial patch" contract (this component only
   * ever sees the current snapshot, never mutates it in place).
   */
  import { fuzzyFilter } from '../fuzzy';
  import type { SnippetV1 } from '$lib/relay-client';
  import { Icon } from './icons';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Input from './ui/Input.svelte';
  import TextArea from './ui/TextArea.svelte';

  interface Props {
    open: boolean;
    snippets: SnippetV1[];
    /** The composer's current draft text — prefills the save form's body so "save what I just typed" is the zero-effort path; still fully editable before saving. */
    draftText: string;
    onInsert: (snippet: SnippetV1) => void;
    onSave: (name: string, text: string) => void;
    onDelete: (id: string) => void;
    onClose: () => void;
  }

  const { open, snippets, draftText, onInsert, onSave, onDelete, onClose }: Props = $props();

  let query = $state('');
  let activeIndex = $state(0);
  let showSaveForm = $state(false);
  let newSnippetName = $state('');
  let newSnippetText = $state('');
  let saveError = $state<string | undefined>(undefined);

  const results = $derived(fuzzyFilter(snippets, query, (entry) => `${entry.name} ${entry.text}`));

  $effect(() => {
    if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
  });

  $effect(() => {
    if (open) {
      query = '';
      activeIndex = 0;
      showSaveForm = false;
      newSnippetName = '';
      newSnippetText = draftText;
      saveError = undefined;
    }
  });

  function activate(entry: SnippetV1): void {
    onInsert(entry);
    onClose();
  }

  function toggleSaveForm(): void {
    showSaveForm = !showSaveForm;
    saveError = undefined;
  }

  function handleSave(): void {
    const name = newSnippetName.trim();
    if (!name) {
      saveError = 'Name is required.';
      return;
    }
    if (!newSnippetText.trim()) {
      saveError = 'Snippet text cannot be empty.';
      return;
    }
    onSave(name, newSnippetText);
    showSaveForm = false;
    newSnippetName = '';
    saveError = undefined;
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
    if (showSaveForm) return; // typing a name/body shouldn't drive row navigation
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
    placeholder="Search snippets…"
    aria-label="Snippet search"
    bind:value={query}
    onkeydown={handleKeydown}
    data-testid="snippet-picker-input"
  />
{/snippet}

{#snippet pickerBody()}
  {#if results.length === 0}
    <EmptyState
      message={snippets.length === 0 ? 'No saved snippets yet.' : 'No matching snippets.'}
    />
  {:else}
    <ul class="picker-results" role="listbox">
      {#each results as entry, index (entry.id)}
        <li>
          <button
            type="button"
            class="picker-item"
            class:active={index === activeIndex}
            role="option"
            aria-selected={index === activeIndex}
            onmouseenter={() => (activeIndex = index)}
            onclick={() => activate(entry)}
            data-testid="snippet-picker-item"
          >
            <span class="entry-icon" aria-hidden="true">
              <Icon name="file" size="100%" />
            </span>
            <span class="entry-body">
              <span class="name">{entry.name}</span>
              <span class="description">{entry.text}</span>
            </span>
          </button>
          <IconButton
            label={`Delete snippet ${entry.name}`}
            size="sm"
            dataTestId="snippet-picker-delete"
            onclick={() => onDelete(entry.id)}
          >
            <Icon name="close" size="12px" />
          </IconButton>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#snippet pickerFooter()}
  <div class="picker-footer">
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onclick={toggleSaveForm}
      dataTestId="snippet-picker-save-toggle"
    >
      {showSaveForm ? 'Cancel' : '+ Save current draft as snippet'}
    </Button>
    {#if showSaveForm}
      <div class="save-form">
        <Field label="Snippet name">
          {#snippet children({ id, describedBy, errorId, invalid, required })}
            <Input
              {id}
              {describedBy}
              {errorId}
              {invalid}
              {required}
              bind:value={newSnippetName}
              placeholder="e.g. Daily standup"
              dataTestId="snippet-picker-name"
            />
          {/snippet}
        </Field>
        <Field label="Snippet text">
          {#snippet children({ id, describedBy, errorId, invalid, required })}
            <TextArea
              {id}
              {describedBy}
              {errorId}
              {invalid}
              {required}
              bind:value={newSnippetText}
              rows={4}
              dataTestId="snippet-picker-text"
            />
          {/snippet}
        </Field>
        {#if saveError}
          <ErrorNotice message={saveError} />
        {/if}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onclick={handleSave}
          dataTestId="snippet-picker-save"
        >
          Save snippet
        </Button>
      </div>
    {:else}
      <div class="picker-hints">
        <span>↑↓ navigate</span>
        <span>Enter insert</span>
        <span>Esc close</span>
      </div>
    {/if}
  </div>
{/snippet}

<Dialog
  {open}
  label="Insert a snippet"
  {onClose}
  size="md"
  class="snippet-picker-panel"
  header={pickerHeader}
  children={pickerBody}
  footer={pickerFooter}
/>

<style>
  :global(.snippet-picker-panel) {
    width: min(30rem, 92vw);
    max-height: 70vh;
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

  .picker-results li {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
  }

  .picker-item {
    flex: 1;
    min-width: 0;
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
    font-weight: 500;
  }

  .description {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-caption-size);
    color: var(--color-text-secondary);
  }

  .picker-footer {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .save-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .picker-hints {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-md);
    font-size: var(--text-caption-size);
    color: var(--color-text-muted);
  }
</style>
