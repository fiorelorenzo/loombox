<script lang="ts">
  /**
   * One tool-call permission card (SPEC.md §7.24 "Tool-call permissions",
   * issues #144/#148): rendered inline at the tool-call/composer site, one
   * focused card at a time — never a blocking modal. Fields render straight
   * off `request.toolCall` (title, rawInput, content, locations; ACP has no
   * `subject` field) rather than being re-derived, so a mobile approval
   * card shows the real command/diff (issue #144's acceptance). The button
   * set is whatever `request.options[]` carries — ACP's own provider-
   * adapted `name`s (Claude's "Allow once"/"Allow all edits"/etc, Codex's
   * "Yes"/"Yes for session"/etc, or the generic tier's Allow/Deny) — this
   * component never hardcodes a per-provider label table.
   *
   * Keyboard shortcuts (issue #148): digit keys `1..n` resolve with the
   * matching `options[]` entry; `Esc` defers (blurs, leaves the request
   * queued, does not resolve). Both only fire while this card itself is
   * focused (the `keydown` listener lives on the card's own root), and only
   * when `actionable` (SPEC.md §7.24's nested-visibility rule: only the
   * current FIFO head is actionable).
   */
  import type { AcpPermissionOption } from '@loombox/providers-core';
  import type { PendingPermissionRequest } from '@loombox/providers-core';
  import DiffViewer from './DiffViewer.svelte';

  interface Props {
    request: PendingPermissionRequest;
    /** Only the session's current FIFO head is actionable (SPEC.md §7.24). */
    actionable: boolean;
    onResolve: (option: AcpPermissionOption) => void;
    /** Esc: defer without resolving (issue #148). */
    onDefer?: () => void;
  }

  const { request, actionable, onResolve, onDefer }: Props = $props();

  function optionClass(kind: AcpPermissionOption['kind']): string {
    return kind === 'allow_once' || kind === 'allow_always' ? 'option allow' : 'option reject';
  }

  function rawInputText(rawInput: unknown): string | undefined {
    if (rawInput === undefined) return undefined;
    return typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2);
  }

  function contentText(content: unknown): string | undefined {
    if (content === undefined) return undefined;
    return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  }

  function locationsText(locations: unknown): string | undefined {
    if (locations === undefined) return undefined;
    return typeof locations === 'string' ? locations : JSON.stringify(locations);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!actionable) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      (event.currentTarget as HTMLElement).blur();
      onDefer?.();
      return;
    }
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < request.options.length) {
      event.preventDefault();
      onResolve(request.options[index]);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="permission-card"
  class:actionable
  role="group"
  tabindex="0"
  aria-label={`Permission request: ${request.toolCall.title ?? request.toolCall.id}`}
  onkeydown={handleKeydown}
  data-testid="permission-card"
>
  <div class="header">
    <span class="title">{request.toolCall.title ?? request.toolCall.id}</span>
  </div>

  {#if request.toolCall.diff}
    <DiffViewer
      path={request.toolCall.diff.path}
      oldText={request.toolCall.diff.oldText}
      newText={request.toolCall.diff.newText}
    />
  {:else if contentText(request.toolCall.content)}
    <pre class="field content">{contentText(request.toolCall.content)}</pre>
  {:else if rawInputText(request.toolCall.rawInput)}
    <pre class="field raw-input">{rawInputText(request.toolCall.rawInput)}</pre>
  {/if}

  {#if locationsText(request.toolCall.locations)}
    <p class="locations">{locationsText(request.toolCall.locations)}</p>
  {/if}

  <div class="options">
    {#each request.options as option, index (option.optionId)}
      <button
        type="button"
        class={optionClass(option.kind)}
        disabled={!actionable}
        onclick={() => onResolve(option)}
      >
        <span class="shortcut">{index + 1}</span>
        {option.name}
      </button>
    {/each}
  </div>
</div>

<style>
  .permission-card {
    border: 1px solid #f59e0b;
    border-radius: 0.6rem;
    padding: 0.6rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    background: rgba(245, 158, 11, 0.06);
  }

  .permission-card:not(.actionable) {
    opacity: 0.55;
  }

  .permission-card:focus-visible {
    outline: 2px solid #f59e0b;
    outline-offset: 2px;
  }

  .title {
    font-weight: 600;
  }

  .field {
    margin: 0;
    padding: 0.4rem 0.5rem;
    background: rgba(127, 127, 127, 0.08);
    border-radius: 0.35rem;
    overflow-x: auto;
    white-space: pre-wrap;
    font-size: 0.8rem;
  }

  .locations {
    margin: 0;
    opacity: 0.65;
    font-size: 0.75rem;
  }

  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .option {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border-radius: 0.35rem;
    border: 1px solid currentColor;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    background: transparent;
    font-size: 0.85rem;
  }

  .option.allow {
    color: #16a34a;
  }

  .option.reject {
    color: #dc2626;
  }

  .option:disabled {
    cursor: not-allowed;
  }

  .shortcut {
    opacity: 0.55;
    font-size: 0.7rem;
    border: 1px solid currentColor;
    border-radius: 0.2rem;
    padding: 0 0.25rem;
  }
</style>
