<script lang="ts">
  /**
   * The shared list-row primitive (v6 design-system audit §1.4, issue
   * #579): every row in the app hand-rolls its own leading/content/
   * trailing flex layout, hover tint and selected/active treatment —
   * the session row and its collapsed-rail twin, the destination nav row,
   * the attention inbox row, and the target rows (`+page.svelte:2071`,
   * `:2191`, `:2268`; `AttentionInbox.svelte:238`; `TargetStatusView`'s
   * `.target-row`). Derived from all of them, not invented: a leading slot
   * (status dot, avatar, chevron), the row's own content (title/meta, or
   * any stacked block — a row's content is not always one line), an
   * optional trailing slot (a badge, a timestamp, a hover-revealed action
   * cluster), and whether the row itself is a `button`, a link (`a`), or a
   * plain element (`div`/`li`) a caller drives with its own `onclick`.
   *
   * Call-site migration is split across issues (issue #579's own scope
   * note): this ships the primitive, a `/style-reference` proof-of-use,
   * and migrates `AttentionInbox`'s inbox row. `+page.svelte`'s session/
   * destination/target rows migrate later, but this shape has to fit them
   * already — they are the hardest callers, not an afterthought.
   *
   * `as="div"`/`as="li"` with an `onclick` gets a synthesized
   * `role="button"`, `tabindex="0"` and an Enter/Space `keydown` handler
   * for free — never wire that up by hand at a call site. This is the
   * shape a row with its own trailing action cluster needs (the session
   * row's hover `⋯` menu is exactly this case): a real `<button>` cannot
   * contain another interactive control, so a row that needs one renders
   * as a plain element with button *semantics* instead of the literal tag.
   * `as="button"`/`as="a"` render the native element and its native
   * keyboard handling — reach for those only when there is no trailing
   * interactive content.
   *
   * The trailing slot's own clicks never bubble into the row's `onclick`
   * (a `stopPropagation` boundary wraps it): a trailing action cluster is
   * always a separate target from the row's own click, never a second way
   * to trigger — or accidentally double-fire — it.
   *
   * `surface` (issue #665) draws the shared card treatment (background/
   * border, plus the matching hover tint) directly on `Row`'s own root —
   * for a row that needs to read as a standalone card rather than a plain
   * list row (e.g. `AttentionInbox`'s item). Mirrors `ToolCard`'s own
   * required `surface` prop precedent (#576): a call site that used to
   * fight `.ui-row`'s scoped root rule with a `:global()` override (losing
   * the specificity fight silently — verified by compiling both and
   * reading the emitted CSS) gets a prop instead.
   */
  import type { Snippet } from 'svelte';

  export type RowElement = 'div' | 'li' | 'button' | 'a';

  interface Props {
    as?: RowElement;
    /** The link target — required when `as="a"`, ignored otherwise. */
    href?: string;
    onclick?: (event: MouseEvent) => void;
    /** Selected/current treatment — a caller maps its own vocabulary (`.selected`, `.active`) onto this one flag, exactly like StatusDot's `tone`. */
    active?: boolean;
    /** Draws the shared card background/border/hover treatment on the root element (issue #665) — omit for a plain, chromeless row. */
    surface?: boolean;
    disabled?: boolean;
    leading?: Snippet;
    trailing?: Snippet;
    children: Snippet;
    ariaLabel?: string;
    title?: string;
    /** Additional class name(s) merged onto the root element. */
    class?: string;
    dataTestId?: string;
    [key: `data-${string}` | `aria-${string}`]: unknown;
  }

  const {
    as = 'div',
    href,
    onclick,
    active = false,
    surface = false,
    disabled = false,
    leading,
    trailing,
    children,
    ariaLabel,
    title,
    class: className = '',
    dataTestId = 'ui-row',
    ...rest
  }: Props = $props();

  const isNative = $derived(as === 'button' || as === 'a');

  function handleClick(event: MouseEvent): void {
    if (disabled) return;
    onclick?.(event);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (isNative || !onclick || disabled) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onclick(event as unknown as MouseEvent);
    }
  }

  // Any click inside the trailing slot is a separate target from the row's
  // own click (see the file doc comment) — stopped here, before it can
  // bubble up to the root element's own onclick.
  function stopTrailingClick(event: MouseEvent): void {
    event.stopPropagation();
  }
</script>

<svelte:element
  this={as}
  {...rest}
  type={as === 'button' ? 'button' : undefined}
  disabled={as === 'button' ? disabled : undefined}
  href={as === 'a' && !disabled ? href : undefined}
  aria-disabled={as === 'a' && disabled ? true : undefined}
  role={!isNative && onclick ? 'button' : undefined}
  tabindex={!isNative && onclick ? (disabled ? -1 : 0) : undefined}
  onclick={onclick ? handleClick : undefined}
  onkeydown={!isNative && onclick ? handleKeydown : undefined}
  aria-label={ariaLabel}
  {title}
  class={`ui-row ui-row-${as} ${className}`.trim()}
  class:ui-row-active={active}
  class:ui-row-surface={surface}
  class:ui-row-clickable={!!onclick}
  data-testid={dataTestId}
>
  {#if leading}
    <span class="ui-row-leading">{@render leading()}</span>
  {/if}
  <span class="ui-row-content">{@render children()}</span>
  {#if trailing}
    <!-- Not itself interactive — a click-propagation boundary only (see
         the file doc comment). Whatever the caller renders inside it
         (a button, an icon control) carries its own accessible semantics. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <span class="ui-row-trailing" onclick={stopTrailingClick}>{@render trailing()}</span>
  {/if}
</svelte:element>

<style>
  .ui-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-sm);
    border-radius: var(--radius-lg);
    color: inherit;
    text-align: left;
    text-decoration: none;
    font: inherit;
    background: transparent;
    border: none;
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .ui-row-button,
  .ui-row-a {
    width: 100%;
  }

  .ui-row-clickable {
    cursor: pointer;
  }

  .ui-row-clickable:hover {
    background: var(--color-fill-subtle);
  }

  .ui-row-clickable:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* tension-press (redesign brief §2): no bounce/overshoot. */
  .ui-row-button:not(:disabled):active,
  .ui-row-a:active {
    transform: scale(0.995);
  }

  .ui-row-button:disabled,
  .ui-row[aria-disabled='true'] {
    cursor: not-allowed;
    opacity: 0.55;
  }

  /* Selected/current treatment — a 2px accent left-bar + subtle tint, never
     a solid accent border/fill (accent reserved for meaning). */
  .ui-row-active {
    background: var(--color-accent-subtle);
    box-shadow: inset 2px 0 0 0 var(--color-accent);
  }

  /* `surface` (issue #665): the card treatment — background/border plus a
     matching hover tint — for a row that reads as a standalone card
     rather than a plain list row (e.g. `AttentionInbox`'s item). Mirrors
     `ToolCard`'s own `surface` prop precedent (#576). */
  .ui-row-surface {
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle);
  }

  .ui-row-surface:hover {
    background: var(--color-fill-subtle);
  }

  .ui-row-leading {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .ui-row-content {
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
    flex: 1;
    min-width: 0;
  }

  .ui-row-trailing {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    margin-left: auto;
  }
</style>
