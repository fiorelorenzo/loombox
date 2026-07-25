<script lang="ts">
  /**
   * The composer's attachment picker + pending-attachment strip (SPEC.md
   * §7.25; issues #151/#152/#153/#155). Paste, drop, or file-pick all funnel
   * into the same `onFiles` callback — the caller (`+page.svelte`) is
   * expected to call `RelayClient.attachFile` once per file, which owns the
   * actual magic-byte validation, encrypt, and upload (`relay-client.ts`);
   * this component only renders whatever `attachments` it's handed and
   * relays user intent (pick/drop/paste/retry/remove) back up — no
   * validation or upload logic duplicated here.
   *
   * Each attachment renders as a small chip: an image preview when one's
   * available (the instant local object-URL preview, SPEC §7.25), the file
   * name, and a status affordance — a spinner while `'uploading'`, a Retry
   * button for `'failed'` (issue #155's manual retry control), or the
   * rejection/failure message for `'rejected'`/`'failed'`. Every chip has a
   * remove (×) control.
   *
   * Warp Deck restyle (docs/design/redesign.md §4/§6, issue #439): "collapses
   * to a paperclip IconButton that only expands into a chip row once
   * something's attached" — the trigger is now icon-only (adopts the shared
   * `IconButton` primitive; no fixed testid collision since this component's
   * own load-bearing testids/labels are all preserved verbatim), and Retry
   * adopts the shared `Button` (`danger`/`sm`) — neither needs an attribute
   * `IconButton`/`Button` can't pass through, unlike this file's own root
   * drop-zone (which keeps its hand-rolled markup: it needs the raw
   * `ondrop`/`ondragover`/`ondragleave`/`onpaste` handlers on the exact
   * element `attachment-bar`'s tests target).
   *
   * Deck migration (issue #469): both glyphs (the paperclip trigger, the
   * chip's remove control) now draw from the shared bespoke icon set
   * (`icons/Icon.svelte`, issue #457) — `attach`/`close` — instead of a
   * one-off inline SVG and a bare `×` character.
   */
  import type { ComposerAttachment } from '../attachments';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import { Icon } from './icons';

  interface Props {
    attachments: ComposerAttachment[];
    onFiles: (files: File[]) => void;
    onRetry: (id: string) => void;
    onRemove: (id: string) => void;
  }

  const { attachments, onFiles, onRetry, onRemove }: Props = $props();

  let fileInput: HTMLInputElement | undefined = $state(undefined);
  let dragActive = $state(false);

  function pickFiles(): void {
    fileInput?.click();
  }

  function handleInputChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    if (files.length > 0) onFiles(files);
    // Reset so picking the exact same file again still fires 'change'.
    input.value = '';
  }

  function handleDrop(event: DragEvent): void {
    event.preventDefault();
    dragActive = false;
    const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
    if (files.length > 0) onFiles(files);
  }

  function handleDragOver(event: DragEvent): void {
    event.preventDefault();
    dragActive = true;
  }

  function handleDragLeave(): void {
    dragActive = false;
  }

  function handlePaste(event: ClipboardEvent): void {
    const files = event.clipboardData?.files ? Array.from(event.clipboardData.files) : [];
    if (files.length > 0) {
      event.preventDefault();
      onFiles(files);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="attachment-bar"
  class:drag-active={dragActive}
  data-testid="attachment-bar"
  tabindex="0"
  ondrop={handleDrop}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  onpaste={handlePaste}
>
  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    multiple
    class="file-input"
    aria-label="Attach images"
    onchange={handleInputChange}
  />
  <IconButton label="Attach image" onclick={pickFiles} class="pick-button">
    <Icon name="attach" />
  </IconButton>

  {#if attachments.length > 0}
    <ul class="chips">
      {#each attachments as attachment (attachment.id)}
        <li
          class="chip"
          class:failed={attachment.status === 'failed'}
          data-testid="attachment-chip"
        >
          {#if attachment.previewUrl}
            <img class="preview" src={attachment.previewUrl} alt={attachment.name} />
          {:else}
            <div class="preview placeholder" aria-hidden="true"></div>
          {/if}

          <div class="meta">
            <span class="name">{attachment.name}</span>
            {#if attachment.status === 'uploading'}
              <span class="status uploading">Uploading…</span>
            {:else if attachment.status === 'failed'}
              <span class="status error" role="alert">{attachment.error}</span>
            {:else if attachment.status === 'rejected'}
              <span class="status error" role="alert">{attachment.error}</span>
            {/if}
          </div>

          {#if attachment.status === 'failed'}
            <Button
              variant="danger"
              size="sm"
              class="retry"
              onclick={() => onRetry(attachment.id)}
              ariaLabel={`Retry ${attachment.name}`}
            >
              Retry
            </Button>
          {/if}

          <IconButton
            label={`Remove ${attachment.name}`}
            onclick={() => onRemove(attachment.id)}
            class="remove"
          >
            <Icon name="close" />
          </IconButton>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .attachment-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-sm);
    border-radius: var(--radius-lg);
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .attachment-bar.drag-active {
    background: var(--color-accent-subtle);
    outline: 1px dashed var(--color-accent);
    outline-offset: 2px;
  }

  .file-input {
    display: none;
  }

  :global(.pick-button) {
    align-self: center;
  }

  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
  }

  .chip {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    border-radius: var(--radius-lg);
    padding: var(--space-2xs) var(--space-xs);
    max-width: 16rem;
    animation: chip-in var(--duration-base) var(--ease-beat) both;
  }

  @keyframes chip-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .chip.failed {
    border-color: var(--color-danger);
  }

  .preview {
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-sm);
    object-fit: cover;
    flex-shrink: 0;
  }

  .preview.placeholder {
    background: var(--color-fill);
  }

  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: var(--space-3xs);
  }

  .name {
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    font-size: 0.7rem;
    color: var(--color-text-secondary);
  }

  .status.error {
    color: var(--color-danger);
    white-space: normal;
  }

  :global(.retry) {
    flex-shrink: 0;
  }

  :global(.remove) {
    flex-shrink: 0;
    opacity: 0.6;
  }

  :global(.remove:hover) {
    opacity: 1;
  }
</style>
