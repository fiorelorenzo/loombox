<script lang="ts">
  /**
   * The shared multi-line text control (coherence v5 design spec §1, issue
   * #508): the composer-shaped textareas in dialogs (`NewSessionDialog`'s
   * starting prompt) — same duplicated CSS block `Input.svelte` replaces,
   * just on a `<textarea>`. See that file's doc comment for the
   * `--color-surface-raised`/`monospace`/`Field`-wiring notes, all
   * identical here.
   */
  interface Props {
    value?: string;
    id?: string;
    placeholder?: string;
    disabled?: boolean;
    required?: boolean;
    monospace?: boolean;
    /** Defaults to 4 — a composer-shaped starting height, not the browser's bare 2-row default every hand-rolled copy inherited. */
    rows?: number;
    ariaLabel?: string;
    describedBy?: string;
    errorId?: string;
    invalid?: boolean;
    class?: string;
    dataTestId?: string;
    oninput?: (event: Event & { currentTarget: HTMLTextAreaElement }) => void;
    onchange?: (event: Event & { currentTarget: HTMLTextAreaElement }) => void;
  }

  let {
    value = $bindable(''),
    id,
    placeholder,
    disabled = false,
    required = false,
    monospace = false,
    rows = 4,
    ariaLabel,
    describedBy,
    errorId,
    invalid = false,
    class: className = '',
    dataTestId = 'ui-textarea',
    oninput,
    onchange,
  }: Props = $props();
</script>

<textarea
  {id}
  {placeholder}
  {disabled}
  {required}
  {rows}
  bind:value
  {oninput}
  {onchange}
  aria-label={ariaLabel}
  aria-describedby={describedBy}
  aria-errormessage={errorId}
  aria-invalid={invalid ? 'true' : undefined}
  aria-required={required ? 'true' : undefined}
  class={`ui-textarea ${monospace ? 'font-mono' : ''} ${className}`.trim()}
  data-testid={dataTestId}></textarea>

<style>
  .ui-textarea {
    width: 100%;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface-raised);
    color: inherit;
    font-family: inherit;
    font-size: var(--text-body-size);
    resize: vertical;
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .ui-textarea::placeholder {
    color: var(--color-text-muted);
  }

  .ui-textarea:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }

  .ui-textarea:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .ui-textarea:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .ui-textarea[aria-invalid='true'] {
    border-color: var(--color-danger);
  }

  /* iOS Safari auto-zooms the viewport on focusing a text control whose
     computed font-size is under 16px — a platform minimum, not a `--text-*`
     scale gap, so `1rem` stays literal here the same way `ui/Input`'s
     matching coarse-pointer rule does (issue #508 token-hygiene audit:
     considered and kept literal). */
  @media (pointer: coarse) {
    .ui-textarea {
      font-size: 1rem;
    }
  }
</style>
