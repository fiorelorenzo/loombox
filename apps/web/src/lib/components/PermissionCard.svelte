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
  import { triggerHapticFeedback } from '$lib/haptics';

  /** Below this many options, there's nothing to collapse into an overflow menu even on a narrow viewport. */
  const NARROW_PRIMARY_OPTION_COUNT = 2;

  interface Props {
    request: PendingPermissionRequest;
    /** Only the session's current FIFO head is actionable (SPEC.md §7.24). */
    actionable: boolean;
    onResolve: (option: AcpPermissionOption) => void;
    /** Esc: defer without resolving (issue #148). */
    onDefer?: () => void;
    /**
     * SPEC.md §7.3 "Narrow-viewport permission footer" / "Scrollable option
     * lists" (issue #134): on a narrow viewport the button row collapses to
     * its two primary actions plus an overflow control for the rest of the
     * provider's option set, and that overflow list caps its height and
     * scrolls internally rather than pushing the primary buttons off-screen.
     * Defaults `false` (the existing full-row desktop layout) so every
     * other caller/test is unaffected; the real viewport-width check lives
     * in the caller (`+page.svelte`'s viewport store), not this component.
     */
    narrow?: boolean;
    /** Injectable for tests; defaults to the real Vibration API (SPEC.md §7.3, issue #133). */
    hapticFn?: typeof triggerHapticFeedback;
  }

  const {
    request,
    actionable,
    onResolve,
    onDefer,
    narrow = false,
    hapticFn = triggerHapticFeedback,
  }: Props = $props();

  let overflowOpen = $state(false);

  const primaryOptions = $derived(
    narrow ? request.options.slice(0, NARROW_PRIMARY_OPTION_COUNT) : request.options,
  );
  const overflowOptions = $derived(
    narrow ? request.options.slice(NARROW_PRIMARY_OPTION_COUNT) : [],
  );

  function optionClass(kind: AcpPermissionOption['kind']): string {
    return kind === 'allow_once' || kind === 'allow_always' ? 'option allow' : 'option reject';
  }

  /**
   * Confirm/deny is irreversible (SPEC.md §7.3), so every resolve gets a
   * short haptic cue on a device that supports it — a silent no-op
   * elsewhere (`triggerHapticFeedback`'s own guard). Mirrors
   * `handleKeydown`'s own `if (!actionable) return` guard: the option
   * buttons are `disabled` when not actionable, but a synthetic click
   * (e.g. a test's `fireEvent.click`, which — unlike a real user click —
   * jsdom does not itself suppress on a disabled button) must not resolve
   * or vibrate regardless.
   */
  function resolveOption(option: AcpPermissionOption): void {
    if (!actionable) return;
    overflowOpen = false;
    hapticFn();
    onResolve(option);
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
      resolveOption(request.options[index]);
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

  <div class="options" class:narrow data-testid="permission-options">
    {#each primaryOptions as option (option.optionId)}
      <button
        type="button"
        class={optionClass(option.kind)}
        disabled={!actionable}
        onclick={() => resolveOption(option)}
      >
        <span class="shortcut">{request.options.indexOf(option) + 1}</span>
        {option.name}
      </button>
    {/each}

    {#if overflowOptions.length > 0}
      <button
        type="button"
        class="option overflow-toggle"
        disabled={!actionable}
        aria-expanded={overflowOpen}
        onclick={() => (overflowOpen = !overflowOpen)}
        data-testid="permission-overflow-toggle"
      >
        More ({overflowOptions.length})
      </button>
    {/if}
  </div>

  {#if overflowOpen && overflowOptions.length > 0}
    <div class="options-overflow" data-testid="permission-options-scroll">
      {#each overflowOptions as option (option.optionId)}
        <button
          type="button"
          class={optionClass(option.kind)}
          disabled={!actionable}
          onclick={() => resolveOption(option)}
        >
          <span class="shortcut">{request.options.indexOf(option) + 1}</span>
          {option.name}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .permission-card {
    border: 1px solid var(--color-warning);
    border-radius: var(--radius-xl);
    padding: var(--space-sm) var(--space-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    background: var(--color-warning-subtle);
  }

  .permission-card:not(.actionable) {
    opacity: 0.55;
  }

  .permission-card:focus-visible {
    outline: 2px solid var(--color-warning);
    outline-offset: 2px;
  }

  .title {
    font-weight: 600;
  }

  .field {
    margin: 0;
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-fill-subtle);
    border-radius: var(--radius-md);
    overflow-x: auto;
    white-space: pre-wrap;
    font-size: var(--text-small-size);
    font-family: var(--font-mono);
  }

  .locations {
    margin: 0;
    opacity: 0.65;
    font-size: var(--text-small-size);
  }

  .options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
  }

  /* Narrow-viewport permission footer (SPEC.md §7.3; issue #134): the
     primary two actions stay on one reachable row, never wrapped away by
     an overflow control that has nowhere left to go. */
  .options.narrow {
    flex-wrap: nowrap;
  }

  .overflow-toggle {
    color: inherit;
    opacity: 0.75;
  }

  /* Scrollable option lists (issue #134): capped height so a long
     options[] list scrolls internally instead of pushing the primary
     buttons off-screen on a small display. */
  .options-overflow {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    max-height: 10rem;
    overflow-y: auto;
  }

  .option {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    border-radius: var(--radius-md);
    border: 1px solid currentColor;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    background: transparent;
    font-size: var(--text-small-size);
  }

  .option.allow {
    color: var(--color-success);
  }

  .option.reject {
    color: var(--color-danger);
  }

  .option:disabled {
    cursor: not-allowed;
  }

  .shortcut {
    opacity: 0.55;
    font-size: 0.7rem;
    border: 1px solid currentColor;
    border-radius: var(--radius-sm);
    padding: 0 var(--space-2xs);
  }

  /* Touch-optimized permission controls (SPEC.md §7.3, issue #133): on a
     coarse (touch) pointer, the confirm/deny/overflow buttons grow to at
     least the ~44px hit target both major mobile platforms recommend,
     instead of the compact desktop sizing above. */
  @media (pointer: coarse) {
    .option {
      min-height: 2.75rem;
      padding: 0.55rem 0.9rem;
      font-size: 0.95rem;
    }
  }
</style>
