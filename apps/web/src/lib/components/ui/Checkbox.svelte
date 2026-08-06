<script lang="ts">
  /**
   * The shared toggle switch (coherence v5 design spec §1, issue #508):
   * `McpServerConfigPanel`, `PluginConfigPanel`, and `NotificationPreferences`
   * each hand-built a near-identical one — a real `<input type="checkbox">`
   * with only its `appearance` suppressed (so `checked`/`onchange`/
   * `data-testid` behavior is byte-for-byte a plain checkbox underneath),
   * styled as a pill track with a sliding fill. This primitive is that
   * exact treatment, once.
   *
   * Owns its own `<label>` wrapping the track plus a visible label string —
   * every existing call site already wrapped `<label>{switch}{text}</label>`
   * the same way, so this is a direct absorption, not a new pattern. A row
   * that also needs OTHER content next to the switch (a transport-type
   * badge, a "needs secret" badge, a Remove button) renders that content as
   * a SIBLING of `Checkbox` in the row, not inside it — those elements
   * were only ever nested inside the old hand-rolled `<label>` as an
   * accident of markup, not because clicking them should also toggle the
   * switch.
   *
   * `checked` is `$bindable`, but every current call site passes a plain
   * one-way `checked` (derived from a stored record) plus `onCheckedChange`
   * — the record, not local component state, is the source of truth, and
   * `onCheckedChange` is what lets a caller close over an id the way
   * `handleToggle(record.config.name, checked)` needs to.
   */
  interface Props {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    label: string;
    disabled?: boolean;
    id?: string;
    describedBy?: string;
    /** Additional class name(s) merged onto the root `<label>`. */
    class?: string;
    /** Lands on the `<input>` itself, matching every pre-migration call site's own `data-testid={...}-enabled-${name}` convention. */
    dataTestId?: string;
  }

  let {
    checked = $bindable(false),
    onCheckedChange,
    label,
    disabled = false,
    id,
    describedBy,
    class: className = '',
    dataTestId = 'ui-checkbox',
  }: Props = $props();

  function handleChange(event: Event & { currentTarget: HTMLInputElement }): void {
    onCheckedChange?.(event.currentTarget.checked);
  }
</script>

<label class={`ui-checkbox ${className}`.trim()} class:ui-checkbox-disabled={disabled}>
  <span class="ui-checkbox-track">
    <input
      type="checkbox"
      {id}
      bind:checked
      {disabled}
      aria-describedby={describedBy}
      onchange={handleChange}
      data-testid={dataTestId}
    />
    <span class="ui-checkbox-track-fill" aria-hidden="true"></span>
  </span>
  <span class="ui-checkbox-label">{label}</span>
</label>

<style>
  .ui-checkbox {
    display: inline-flex;
    align-items: center;
    gap: var(--space-sm);
    color: var(--color-text-primary);
    cursor: pointer;
  }

  .ui-checkbox-disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .ui-checkbox-track {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    width: 2rem;
    height: 1.15rem;
  }

  .ui-checkbox-track input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: inherit;
    z-index: 1;
  }

  .ui-checkbox-track-fill {
    position: absolute;
    inset: 0;
    border-radius: var(--radius-full);
    background: var(--color-fill);
    border: 1px solid var(--color-border);
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .ui-checkbox-track-fill::before {
    content: '';
    position: absolute;
    top: 1px;
    left: 1px;
    width: calc(1.15rem - 4px);
    height: calc(1.15rem - 4px);
    border-radius: var(--radius-full);
    background: var(--color-text-secondary);
    transition:
      transform var(--duration-fast) var(--ease-beat),
      background-color var(--duration-fast) var(--ease-beat);
  }

  .ui-checkbox-track input:checked + .ui-checkbox-track-fill {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
  }

  .ui-checkbox-track input:checked + .ui-checkbox-track-fill::before {
    background: var(--color-accent);
    transform: translateX(calc(2rem - 1.15rem));
  }

  .ui-checkbox-track input:focus-visible + .ui-checkbox-track-fill {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133) — the same
     44px-ish coarse-pointer enlargement every pre-migration copy of this
     switch already carried. `px`, not `rem` (A2-1, issue #734): `rem`
     resolves against `html`'s font-size, which IS `--text-body-size` —
     see that token's own note in `typography.css` and `--touch-target-
     min`'s in `tokens.css`. `24px`/`4px`/`20px` below are literal rather
     than reading `--touch-target-min` throughout because the track's
     HEIGHT, the thumb inset and the slide distance are this switch's own
     proportions, not the shared 44px floor itself — only the track WIDTH
     is that floor. */
  @media (pointer: coarse) {
    .ui-checkbox-track {
      width: var(--touch-target-min);
      height: 24px;
    }

    .ui-checkbox-track-fill::before {
      width: calc(24px - 4px);
      height: calc(24px - 4px);
    }

    .ui-checkbox-track input:checked + .ui-checkbox-track-fill::before {
      transform: translateX(calc(var(--touch-target-min) - 24px));
    }
  }
</style>
