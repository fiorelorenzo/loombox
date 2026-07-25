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
  import Button from './ui/Button.svelte';
  import StatusDot from './ui/StatusDot.svelte';
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

  /** primary (solid accent) for the affirmative options, danger for reject — Button
   * variants doing the "unmistakable" work the redesign brief asks for, instead of a
   * hand-rolled color class. */
  function optionVariant(kind: AcpPermissionOption['kind']): 'primary' | 'danger' {
    return kind === 'allow_once' || kind === 'allow_always' ? 'primary' : 'danger';
  }
</script>

<!--
  Keyed on requestId (not just mounted once): the redesign brief's thread-draw
  border sweep is meant to fire "when a request arrives" (docs/design/redesign.md
  §6), not only on the very first mount of this component instance. Since
  `PermissionQueueBar` reuses the same `PermissionCard` instance across FIFO heads
  (no key on its own usage), wrapping the root in `{#key}` forces a fresh DOM node
  — and therefore a fresh one-time CSS animation — each time the head request
  actually changes, while leaving it alone (no replay) for any other re-render of
  the same request (e.g. `actionable`/`narrow` flipping).
-->
{#key request.requestId}
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
      <StatusDot
        tone={actionable ? 'warning' : 'neutral'}
        pulse={actionable}
        label={actionable ? 'Waiting for your response' : 'Queued'}
      />
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
        <Button
          variant={optionVariant(option.kind)}
          size="sm"
          disabled={!actionable}
          onclick={() => resolveOption(option)}
        >
          <span class="shortcut">{request.options.indexOf(option) + 1}</span>
          {option.name}
        </Button>
      {/each}

      {#if overflowOptions.length > 0}
        <!--
          Hand-styled to match Button's ghost variant rather than importing the
          primitive: this control needs `data-testid`/`aria-expanded` on the real
          button element itself (what the existing test queries and clicks), and
          `Button` has no attribute passthrough for either.
        -->
        <button
          type="button"
          class="overflow-toggle"
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
          <Button
            variant={optionVariant(option.kind)}
            size="sm"
            disabled={!actionable}
            onclick={() => resolveOption(option)}
          >
            <span class="shortcut">{request.options.indexOf(option) + 1}</span>
            {option.name}
          </Button>
        {/each}
      </div>
    {/if}
  </div>
{/key}

<style>
  /* Floating elevation tier (docs/design/redesign.md §3): the one deliberate
     exception to "status color is a left-edge stripe, never a tinted card" —
     this card is meant to interrupt, so it earns the full raised surface +
     `--shadow-lg` + a warning-toned border (state: this needs your response),
     not a flat 1px rule sitting on a warning-subtle fill. */
  .permission-card {
    position: relative;
    border: 1px solid var(--color-warning);
    border-radius: var(--radius-lg);
    padding: var(--space-md) var(--space-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-lg);
  }

  /* thread-draw (docs/design/redesign.md §2): a one-time top-edge border
     sweep signaling "a request just arrived" — accent, not the card's own
     warning state color, so the two meanings (state vs. arrival event) stay
     visually distinct. Plays once per `{#key request.requestId}` mount and
     never loops or replays while the same request stays on screen. */
  .permission-card::before {
    content: '';
    position: absolute;
    inset: -1px -1px auto -1px;
    height: 2px;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: var(--color-accent);
    clip-path: inset(0 100% 0 0);
    animation: permission-card-thread-draw var(--duration-weave) var(--ease-tension) forwards;
    pointer-events: none;
  }

  @keyframes permission-card-thread-draw {
    to {
      clip-path: inset(0 0 0 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .permission-card::before {
      animation: none;
      clip-path: inset(0 0 0 0);
    }
  }

  .permission-card:not(.actionable) {
    opacity: 0.55;
  }

  .permission-card:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
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
    align-items: center;
    gap: var(--space-xs);
  }

  /* Narrow-viewport permission footer (SPEC.md §7.3; issue #134): the
     primary two actions stay on one reachable row, never wrapped away by
     an overflow control that has nowhere left to go. */
  .options.narrow {
    flex-wrap: nowrap;
  }

  /* Hand-styled to match ui-button-ghost (see the template comment above on
     why this isn't the imported `Button` component). */
  .overflow-toggle {
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    padding: var(--space-2xs) var(--space-md);
    background: transparent;
    color: inherit;
    opacity: 0.75;
    font-size: var(--text-small-size);
    font-weight: 600;
    cursor: pointer;
    transition: opacity var(--duration-fast) var(--ease-beat);
  }

  .overflow-toggle:not(:disabled):hover {
    opacity: 1;
    text-decoration: underline;
  }

  .overflow-toggle:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .overflow-toggle:disabled {
    cursor: not-allowed;
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

  /* Keycap-style shortcut chip: a small raised tile (not just a bordered
     digit) echoing a physical key, sitting inside each option Button's own
     label. */
  .shortcut {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.1rem;
    margin-right: var(--space-2xs);
    opacity: 0.85;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    border: 1px solid currentColor;
    border-radius: var(--radius-sm);
    padding: 0 var(--space-2xs);
    box-shadow: 0 1px 0 currentColor;
  }

  /* Touch-optimized permission controls (SPEC.md §7.3, issue #133): on a
     coarse (touch) pointer, the confirm/deny/overflow buttons grow to at
     least the ~44px hit target both major mobile platforms recommend. The
     option buttons are the shared `Button` primitive now (`size="sm"`,
     which alone only grows to 2.5rem under coarse pointer) — this keeps the
     permission card's own, slightly larger, pre-existing touch target. */
  @media (pointer: coarse) {
    .options :global(.ui-button),
    .options-overflow :global(.ui-button) {
      min-height: 2.75rem;
      padding: 0.55rem 0.9rem;
      font-size: 0.95rem;
    }

    .overflow-toggle {
      min-height: 2.75rem;
      padding: 0.55rem 0.9rem;
      font-size: 0.95rem;
    }
  }
</style>
