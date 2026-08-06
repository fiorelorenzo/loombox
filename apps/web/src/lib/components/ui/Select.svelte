<script lang="ts">
  /**
   * The shared custom-select primitive (redesign v3 design spec §3.5,
   * issue #502): a button trigger plus an anchored listbox, replacing
   * every native `<select>` in the app (`ConfigBar`'s per-category
   * pickers, `NewSessionDialog`'s Provider field, and any future config
   * panel) so a control bar never mixes two visual languages the way
   * `ConfigBar` used to — a native `<select>` sitting next to the
   * hand-rolled `mode` segmented control (defect `C8`).
   *
   * Deliberately NOT `Overlay`-backed and never dims the app behind it
   * (the batch's z-index contract: "anchored popovers use NO scrim —
   * position them, don't use `Overlay`"). The listbox is a plain
   * `position: absolute` child of this component's own `position:
   * relative` root, floated at `--z-sticky` — above ordinary content,
   * below the Drawer's `--z-overlay` / `Dialog`'s `--z-modal`, so a
   * `Select` opened inside a `Dialog` still draws above the dialog's own
   * body content (nesting inside the dialog's already-elevated stacking
   * context, not competing with it). It flips to open upward when there
   * isn't room below the trigger — `ConfigBar` sits directly above the
   * composer, close to the bottom of the viewport, so downward-only would
   * routinely clip.
   *
   * Focus never leaves the trigger button — the ARIA "collapsible
   * select-only listbox" pattern (APG), not a listbox that itself takes
   * focus: `aria-activedescendant` on the button tracks the keyboard-active
   * option while the listbox stays inert. That is what makes "Escape
   * closes and returns focus to the trigger" and "Tab closes" both
   * trivial — focus was already on the trigger the whole time. Arrow keys
   * only move the active (highlighted) option; a separate Enter/Space
   * commits it and calls `onChange`, the same two-step "highlight, then
   * commit" split an opened native `<select>` gives you.
   *
   * Click-outside mirrors `+page.svelte`'s account-menu popover: a
   * `window` `pointerdown` listener that no-ops for anything inside this
   * component's own root.
   */
  import Icon from '../icons/Icon.svelte';

  export interface SelectOption {
    id: string;
    label: string;
    /** Optional secondary text rendered muted beside the option's label. */
    hint?: string;
  }

  export type SelectSize = 'sm' | 'md';

  interface Props {
    value: string;
    options: SelectOption[];
    onChange: (id: string) => void;
    /**
     * Accessible name for the trigger (e.g. the field's name, "Model") —
     * combined with the current selection for the button's `aria-label` so
     * the announced name never loses the value a native `<select>`'s
     * `<label>` + selected `<option>` would both convey.
     */
    label: string;
    disabled?: boolean;
    size?: SelectSize;
    /** Defaults to `"ui-select"`; also roots the listbox/option element ids so multiple instances on one page never collide. */
    dataTestId?: string;
  }

  const {
    value,
    options,
    onChange,
    label,
    disabled = false,
    size = 'md',
    dataTestId = 'ui-select',
  }: Props = $props();

  // The approximate pixel height of the CSS `max-height: 16rem` below,
  // used only to decide whether to flip the listbox upward — a rough
  // budget, not a layout-critical measurement.
  const LISTBOX_BUDGET_PX = 256;

  let open = $state(false);
  let activeIndex = $state(0);
  let openUpward = $state(false);
  let rootEl = $state<HTMLElement | undefined>(undefined);
  let triggerEl = $state<HTMLButtonElement | undefined>(undefined);

  const selectedIndex = $derived.by(() => {
    const index = options.findIndex((option) => option.id === value);
    return index === -1 ? 0 : index;
  });
  const selectedOption = $derived(options.find((option) => option.id === value));
  const triggerText = $derived(selectedOption?.label ?? options[0]?.label ?? 'Select an option');
  const triggerLabel = $derived(selectedOption ? `${label}: ${selectedOption.label}` : label);

  const listboxId = $derived(`${dataTestId}-listbox`);

  function optionId(index: number): string {
    return `${dataTestId}-option-${index}`;
  }

  function openListbox(): void {
    if (disabled || options.length === 0) return;
    activeIndex = selectedIndex;
    if (triggerEl && typeof window !== 'undefined') {
      const rect = triggerEl.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      openUpward = spaceBelow < LISTBOX_BUDGET_PX && rect.top > spaceBelow;
    }
    open = true;
    triggerEl?.focus();
  }

  function closeListbox(): void {
    open = false;
  }

  function commit(index: number): void {
    const option = options[index];
    closeListbox();
    triggerEl?.focus();
    if (option && option.id !== value) onChange(option.id);
  }

  function moveActive(delta: number): void {
    if (options.length === 0) return;
    activeIndex = (activeIndex + delta + options.length) % options.length;
  }

  function handleTriggerClick(): void {
    if (disabled) return;
    if (open) closeListbox();
    else openListbox();
  }

  function handleTriggerKeydown(event: KeyboardEvent): void {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (open) moveActive(1);
        else openListbox();
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (open) moveActive(-1);
        else openListbox();
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) commit(activeIndex);
        else openListbox();
        break;
      case 'Escape':
        if (!open) return;
        event.preventDefault();
        closeListbox();
        triggerEl?.focus();
        break;
      case 'Tab':
        if (open) closeListbox();
        break;
      default:
        break;
    }
  }

  // Mirrors `+page.svelte`'s account-menu popover dismissal exactly: bound
  // on `window` so a click anywhere outside this component's own root
  // closes it, without swallowing the click itself (no preventDefault/
  // stopPropagation) — whatever the user actually clicked still reacts.
  function handleWindowPointerDown(event: PointerEvent): void {
    if (!open) return;
    const target = event.target;
    if (rootEl && target instanceof Node && rootEl.contains(target)) return;
    closeListbox();
  }
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

<div class="ui-select" bind:this={rootEl} data-testid={dataTestId}>
  <button
    type="button"
    bind:this={triggerEl}
    class={`ui-select-trigger ui-select-trigger-${size}`}
    class:ui-select-trigger-expanded={open}
    role="combobox"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-activedescendant={open ? optionId(activeIndex) : undefined}
    aria-label={triggerLabel}
    {disabled}
    data-size={size}
    onclick={handleTriggerClick}
    onkeydown={handleTriggerKeydown}
    data-testid={`${dataTestId}-trigger`}
  >
    <span class="ui-select-value">{triggerText}</span>
    <Icon name="chevron-down" class="ui-select-chevron" />
  </button>
  {#if open}
    <ul
      class="ui-select-listbox"
      class:ui-select-listbox-up={openUpward}
      role="listbox"
      id={listboxId}
      aria-label={label}
      data-testid={`${dataTestId}-listbox`}
    >
      {#each options as option, index (option.id)}
        <li>
          <button
            type="button"
            role="option"
            tabindex="-1"
            id={optionId(index)}
            aria-selected={option.id === value}
            class="ui-select-option"
            class:ui-select-option-active={index === activeIndex}
            onpointerenter={() => (activeIndex = index)}
            onclick={() => commit(index)}
            data-testid={`${dataTestId}-option-${option.id}`}
          >
            <span class="ui-select-option-label">{option.label}</span>
            {#if option.hint}
              <span class="ui-select-option-hint">{option.hint}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .ui-select {
    position: relative;
    display: inline-flex;
  }

  .ui-select-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-xs);
    width: 100%;
    background: var(--color-surface);
    color: inherit;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font: inherit;
    cursor: pointer;
    transition:
      border-color var(--duration-fast) var(--ease-beat),
      background-color var(--duration-fast) var(--ease-beat);
  }

  .ui-select-trigger-md {
    padding: var(--space-sm) var(--space-lg);
    font-size: var(--text-body-size);
  }

  .ui-select-trigger-sm {
    padding: var(--space-2xs) var(--space-md);
    font-size: var(--text-small-size);
  }

  .ui-select-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* `flex-shrink: 0` used to sit here too, but `Icon`'s own
     `.icon { flex-shrink: 0; }` scoped root rule already provides the
     identical value (issue #665's guard-test scan) — redundant dead CSS,
     dropped rather than kept. */
  .ui-select-chevron {
    color: var(--color-text-secondary);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  /* `Icon`'s own `class` prop lands on an element inside its own
     component scope, not this one — `:global()` under a local ancestor
     class is the same narrowly-scoped pattern `EmptyState`'s
     `.ui-empty-state-mark` override already uses in this package. */
  .ui-select-trigger-expanded :global(.ui-select-chevron) {
    transform: rotate(180deg);
  }

  .ui-select-trigger:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }

  .ui-select-trigger:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .ui-select-trigger:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .ui-select-listbox {
    position: absolute;
    z-index: var(--z-sticky);
    top: calc(100% + var(--space-2xs));
    left: 0;
    min-width: 100%;
    max-height: 16rem;
    overflow-y: auto;
    margin: 0;
    padding: var(--space-2xs);
    list-style: none;
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
  }

  .ui-select-listbox-up {
    top: auto;
    bottom: calc(100% + var(--space-2xs));
  }

  .ui-select-option {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-sm);
    width: 100%;
    padding: var(--space-xs) var(--space-sm);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-primary);
    font: inherit;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .ui-select-option-active {
    background: var(--color-fill-subtle);
  }

  .ui-select-option[aria-selected='true'] {
    color: var(--color-accent);
    background: var(--color-accent-subtle);
  }

  .ui-select-option-hint {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133), the same
     coarse-pointer convention `Button`/`IconButton` already use —
     `var(--touch-target-min)`/`var(--touch-target-compact)`, not a
     `2.75rem`/`2.5rem` literal (A2-1, issue #734: see that token's own
     note in `tokens.css`). */
  @media (pointer: coarse) {
    .ui-select-trigger-md {
      min-height: var(--touch-target-min);
    }

    .ui-select-trigger-sm {
      min-height: var(--touch-target-compact);
    }

    .ui-select-option {
      min-height: var(--touch-target-min);
    }
  }
</style>
