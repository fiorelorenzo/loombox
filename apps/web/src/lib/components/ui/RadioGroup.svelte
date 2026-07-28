<script lang="ts">
  /**
   * The shared exclusive-choice control (coherence v5 design spec §1,
   * issue #508): replaces `NewSessionDialog`'s hand-rolled Workspace
   * choice — a `role="radiogroup"` of `role="radio"` `<button>`s, each a
   * title + description card, not a bare native `<input type="radio">`
   * list (SPEC §7.1's worktree choice is "two different places the agent
   * will write", not an on/off toggle, so each option needs room for its
   * own explanatory sentence). Visual language (raised surface, 2px accent
   * left-bar on selection, tension-press) is lifted verbatim from that
   * component's own pre-migration `.workspace-option` CSS.
   *
   * `labelledBy` is `Field`'s `grouped`-mode `labelId` — a `RadioGroup`
   * used inside a `Field` never needs its own `label` prop, since `Field`
   * already renders and wires the caption; `label` alone (no `labelledBy`)
   * covers a standalone `RadioGroup` with no wrapping `Field`.
   */
  export interface RadioOption {
    value: string;
    label: string;
    description?: string;
  }

  interface Props {
    value: string;
    options: RadioOption[];
    onChange: (value: string) => void;
    /** Accessible name when not wired to an external label via `labelledBy`. */
    label?: string;
    /** `Field`'s `labelId` render-prop — see the file doc comment. */
    labelledBy?: string;
    disabled?: boolean;
    /** Roots the container's own testid and each option's `${dataTestId}-${value}`. */
    dataTestId?: string;
  }

  const {
    value,
    options,
    onChange,
    label,
    labelledBy,
    disabled = false,
    dataTestId = 'ui-radio-group',
  }: Props = $props();
</script>

<div
  class="ui-radio-group"
  role="radiogroup"
  aria-label={labelledBy ? undefined : label}
  aria-labelledby={labelledBy}
  data-testid={dataTestId}
>
  {#each options as option (option.value)}
    <button
      type="button"
      role="radio"
      aria-checked={option.value === value}
      class="ui-radio-option"
      class:ui-radio-option-selected={option.value === value}
      {disabled}
      onclick={() => onChange(option.value)}
      data-testid={`${dataTestId}-${option.value}`}
    >
      <span class="ui-radio-option-title">{option.label}</span>
      {#if option.description}
        <span class="ui-radio-option-desc">{option.description}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .ui-radio-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .ui-radio-option {
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
    text-align: left;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    border-left: 2px solid transparent;
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-sm);
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .ui-radio-option:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .ui-radio-option:not(:disabled):active {
    transform: scale(0.995);
  }

  .ui-radio-option:not(:disabled):hover {
    background: var(--color-fill-subtle);
  }

  .ui-radio-option:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .ui-radio-option-selected {
    border-left-color: var(--color-accent);
    background: var(--color-accent-subtle);
  }

  .ui-radio-option-title {
    font-weight: 500;
  }

  .ui-radio-option-desc {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }
</style>
