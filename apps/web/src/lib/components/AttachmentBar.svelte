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
   */
  import type { ComposerAttachment } from '../attachments';

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
  <button type="button" class="pick-button" onclick={pickFiles}>Attach image</button>

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
            <button
              type="button"
              class="retry"
              onclick={() => onRetry(attachment.id)}
              aria-label={`Retry ${attachment.name}`}
            >
              Retry
            </button>
          {/if}

          <button
            type="button"
            class="remove"
            onclick={() => onRemove(attachment.id)}
            aria-label={`Remove ${attachment.name}`}
          >
            ×
          </button>
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
    gap: 0.5rem;
    padding: 0.3rem;
    border: 1px dashed transparent;
    border-radius: 0.5rem;
  }

  .attachment-bar.drag-active {
    border-color: #4f46e5;
    background: rgba(79, 70, 229, 0.06);
  }

  .file-input {
    display: none;
  }

  .pick-button {
    border: 1px solid rgba(127, 127, 127, 0.4);
    background: transparent;
    color: inherit;
    border-radius: 0.35rem;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 0.8rem;
    align-self: center;
  }

  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border: 1px solid rgba(127, 127, 127, 0.3);
    border-radius: 0.4rem;
    padding: 0.3rem 0.4rem;
    max-width: 16rem;
  }

  .chip.failed {
    border-color: #dc2626;
  }

  .preview {
    width: 2rem;
    height: 2rem;
    border-radius: 0.25rem;
    object-fit: cover;
    flex-shrink: 0;
  }

  .preview.placeholder {
    background: rgba(127, 127, 127, 0.2);
  }

  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 0.1rem;
  }

  .name {
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    font-size: 0.7rem;
    opacity: 0.7;
  }

  .status.error {
    color: #dc2626;
    opacity: 1;
    white-space: normal;
  }

  .retry {
    border: 1px solid #dc2626;
    color: #dc2626;
    background: transparent;
    border-radius: 0.3rem;
    padding: 0.15rem 0.4rem;
    cursor: pointer;
    font-size: 0.7rem;
    flex-shrink: 0;
  }

  .remove {
    border: none;
    background: transparent;
    color: inherit;
    opacity: 0.6;
    cursor: pointer;
    font-size: 0.9rem;
    line-height: 1;
    flex-shrink: 0;
    padding: 0 0.2rem;
  }

  .remove:hover {
    opacity: 1;
  }
</style>
