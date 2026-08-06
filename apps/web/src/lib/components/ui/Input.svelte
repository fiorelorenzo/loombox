<script lang="ts">
  /**
   * The shared single-line text control (coherence v5 design spec §1,
   * issue #508): replaces every bare `<input type="text">` and its
   * duplicated CSS block (`padding: var(--space-sm) var(--space-md);
   * border-radius: var(--radius-md); border: 1px solid var(--color-border);
   * background: var(--color-surface)`), copy-pasted across at least eight
   * components before this primitive existed.
   *
   * Sits on `--color-surface-raised` (not the plain `--color-surface` every
   * hand-rolled copy used) per the design spec's "control on
   * --color-surface-raised" line — a deliberate one-step-up elevation from
   * the old convention, matching `Select`'s trigger tier.
   *
   * `monospace` opts into `--font-mono` for "anything that is a path, a
   * host, a command or an identifier" (design spec §1) — a host field, a
   * recovery code, a device user code, an SSH alias, all set it; a plain
   * title/name field doesn't.
   *
   * `value` is `$bindable`, so an existing call site's `bind:value={x}`
   * keeps working unchanged; a caller that instead wants full control
   * (`NotificationPreferences`'s deliberate "read the new value and persist
   * it atomically in one `onchange` handler" pattern) can pass a plain
   * one-way `value` plus its own `onchange`/`oninput` — both compose with
   * the internal binding, exactly like a raw `<input>` would.
   *
   * `describedBy`/`errorId`/`invalid` are `Field`'s render-prop names,
   * forwarded here by shorthand (`{describedBy}` etc.) at every call site —
   * see `Field.svelte`'s doc comment for the split between the two.
   */
  import type { HTMLInputAttributes } from 'svelte/elements';

  export type InputType = 'text' | 'number' | 'email' | 'password' | 'time' | 'color' | 'search';

  interface Props {
    value?: string;
    type?: InputType;
    id?: string;
    placeholder?: string;
    disabled?: boolean;
    required?: boolean;
    /** Routes the value through `--font-mono` — see the file doc comment. */
    monospace?: boolean;
    autocomplete?: HTMLInputAttributes['autocomplete'];
    autocapitalize?: HTMLInputAttributes['autocapitalize'];
    /** Omitted by default (browser default applies); explicit `true`/`false` renders the HTML enumerated attribute's required string form. */
    spellcheck?: boolean;
    min?: string | number;
    /** Accessible name for a control not wrapped in a `Field` (e.g. a visually-hidden label sitting beside it). */
    ariaLabel?: string;
    /** `Field`'s help-paragraph id — see `Field.svelte`. */
    describedBy?: string;
    /** `Field`'s error-paragraph id — see `Field.svelte`. */
    errorId?: string;
    invalid?: boolean;
    /** Additional class name(s) merged onto the root `<input>`. */
    class?: string;
    dataTestId?: string;
    oninput?: (event: Event & { currentTarget: HTMLInputElement }) => void;
    onchange?: (event: Event & { currentTarget: HTMLInputElement }) => void;
    onkeydown?: (event: KeyboardEvent) => void;
  }

  let {
    value = $bindable(''),
    type = 'text',
    id,
    placeholder,
    disabled = false,
    required = false,
    monospace = false,
    autocomplete,
    autocapitalize,
    spellcheck,
    min,
    ariaLabel,
    describedBy,
    errorId,
    invalid = false,
    class: className = '',
    dataTestId = 'ui-input',
    oninput,
    onchange,
    onkeydown,
  }: Props = $props();
</script>

<input
  {id}
  {type}
  {placeholder}
  {disabled}
  {required}
  {min}
  {autocomplete}
  {autocapitalize}
  spellcheck={spellcheck === undefined ? undefined : spellcheck ? 'true' : 'false'}
  bind:value
  {oninput}
  {onchange}
  {onkeydown}
  aria-label={ariaLabel}
  aria-describedby={describedBy}
  aria-errormessage={errorId}
  aria-invalid={invalid ? 'true' : undefined}
  aria-required={required ? 'true' : undefined}
  class={`ui-input ${monospace ? 'font-mono' : ''} ${className}`.trim()}
  data-testid={dataTestId}
/>

<style>
  .ui-input {
    width: 100%;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface-raised);
    color: inherit;
    font-family: inherit;
    font-size: var(--text-body-size);
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .ui-input::placeholder {
    color: var(--color-text-muted);
  }

  .ui-input:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }

  .ui-input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .ui-input:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .ui-input[aria-invalid='true'] {
    border-color: var(--color-danger);
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133), the same
     coarse-pointer convention every other primitive in this package uses
     — `var(--touch-target-min)`, not a `2.75rem` literal (A2-1, issue
     #734: see that token's own note in `tokens.css`). `font-size: 1rem`
     (not a `--text-*` token) is deliberate too: iOS Safari auto-zooms the
     viewport on focusing a text input whose computed font-size is under
     16px, so this is a platform minimum exactly like the 44px
     `min-height` beside it, not a gap in the type scale (issue #508
     token-hygiene audit: considered and kept literal). */
  @media (pointer: coarse) {
    .ui-input {
      min-height: var(--touch-target-min);
      font-size: 1rem;
    }
  }
</style>
