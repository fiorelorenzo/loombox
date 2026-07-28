<script lang="ts">
  /**
   * The shared label/help/error/required stack (coherence v5 design spec
   * §1, issue #508): every form in the app hand-assembled this — a bare
   * `<span class="field-label">` in some places, a proper `<label for>` in
   * others, sometimes both in the SAME form (`NewSessionDialog`'s Agent
   * field vs its Title field, pre-migration) — and the ARIA wiring
   * (`aria-describedby`, `aria-invalid`, `aria-errormessage`,
   * `aria-required`) was ad hoc: some fields had none at all. `Field` owns
   * that contract once so no call site has to remember it: it generates
   * the ids and hands them to its `children` snippet, which forwards them
   * onto whatever control it wraps (`Input`, `TextArea`, `RadioGroup`, or a
   * composite widget like `DirectoryPicker`) — see each primitive's own
   * `describedBy`/`errorId`/`invalid` props.
   *
   * Two label modes:
   *  - Default: a real `<label for={id}>`, for a field that wraps exactly
   *    one focusable control (`Input`, `TextArea`).
   *  - `grouped`: the label renders as a plain caption (no `for`) and the
   *    generated `labelId` is handed to the child to wire via its own
   *    `aria-labelledby` — for a control that is itself a group
   *    (`RadioGroup`'s `role="radiogroup"`) or a composite widget with no
   *    single native target (`AddProjectDialog`'s `DirectoryPicker`).
   *
   * The look is the devtool register the rest of the app already uses for
   * a section caption (`McpServerConfigPanel`/`AppearanceSettings`'s own
   * `h3`, etc.), not a generic web-form label: `--text-caption-size`
   * uppercase with `--text-caption-tracking`, `--font-mono` — see
   * `typography.css`'s doc comment on why that tracking token exists now.
   *
   * `error`/`aria-errormessage` and `help`/`aria-describedby` are kept as
   * two distinct ARIA mechanisms rather than folded into one
   * `aria-describedby`, per the design spec's own wording and the ARIA APG
   * (`aria-errormessage` is the dedicated error-association attribute,
   * only meaningful alongside `aria-invalid="true"`).
   */
  import type { Snippet } from 'svelte';

  export interface FieldControlProps {
    /** The id to put on the wrapped control (`<label for>`'s target in the default, non-grouped mode). */
    id: string;
    /** The label element's own id — only needed by a `grouped` field's child, to wire its own `aria-labelledby`. */
    labelId: string;
    /** `help`'s paragraph id, present only while `help` is set — pass straight through as the control's `describedBy`. */
    describedBy: string | undefined;
    /** `error`'s paragraph id, present only while `error` is set — pass straight through as the control's `errorId`. */
    errorId: string | undefined;
    invalid: boolean;
    required: boolean;
  }

  interface Props {
    label: string;
    /** Supplementary guidance shown under the control, wired via `aria-describedby`. */
    help?: string;
    /** A validation failure, shown under the control (replaces `help` visually) and wired via `aria-invalid`/`aria-errormessage`. */
    error?: string;
    required?: boolean;
    /** See the file doc comment's "two label modes". */
    grouped?: boolean;
    /** Additional class name(s) merged onto the root element. */
    class?: string;
    children: Snippet<[FieldControlProps]>;
  }

  const {
    label,
    help,
    error,
    required = false,
    grouped = false,
    class: className = '',
    children,
  }: Props = $props();

  // `$props.id()` — a unique, SSR/CSR-stable id per component instance
  // (Svelte 5) — is what lets every id below skip a hand-rolled counter
  // and still never collide across two `Field`s on the same page.
  const uid = $props.id();
  const controlId = `${uid}-control`;
  const labelId = `${uid}-label`;
  const helpId = `${uid}-help`;
  const errorMsgId = `${uid}-error`;

  const describedBy = $derived(help ? helpId : undefined);
  const errorIdOut = $derived(error ? errorMsgId : undefined);
  const invalid = $derived(Boolean(error));
</script>

<div class={`ui-field ${className}`.trim()} data-testid="ui-field">
  {#if grouped}
    <span id={labelId} class="ui-field-label">
      {label}{#if required}<span class="ui-field-required" aria-hidden="true">*</span>{/if}
    </span>
  {:else}
    <label for={controlId} id={labelId} class="ui-field-label">
      {label}{#if required}<span class="ui-field-required" aria-hidden="true">*</span>{/if}
    </label>
  {/if}
  <div class="ui-field-control">
    {@render children({
      id: controlId,
      labelId,
      describedBy,
      errorId: errorIdOut,
      invalid,
      required,
    })}
  </div>
  {#if help}
    <p id={helpId} class="ui-field-help">{help}</p>
  {/if}
  {#if error}
    <p id={errorMsgId} class="ui-field-error" role="alert">{error}</p>
  {/if}
</div>

<style>
  .ui-field {
    display: flex;
    flex-direction: column;
    /* Deliberately tighter than any gap a form puts BETWEEN fields: a label
       belongs to the control under it, and when the two distances are equal
       (both were `--space-2xs`) nothing groups and the form reads as a flat
       list of alternating text and boxes - the exact "generic webapp form"
       tell this wave set out to remove. Anything stacking `Field`s must gap
       them by at least `--space-sm`. */
    gap: var(--space-3xs);
  }

  /* The devtool-register caption look (see the file doc comment) — the
     SAME visual language `h3` section headers already use elsewhere in
     this package, not a second competing "form label" style. */
  .ui-field-label {
    display: block;
    width: fit-content;
    font-family: var(--font-mono);
    font-size: var(--text-caption-size);
    line-height: var(--text-caption-line);
    letter-spacing: var(--text-caption-tracking);
    text-transform: uppercase;
    font-weight: var(--text-caption-weight);
    color: var(--color-text-secondary);
  }

  /* Marks the REQUIRED field, not the optional ones. Before this, five labels
     across two forms spelled "(optional)" into the label text itself while
     `required` was never once set by any call site, so `aria-required` was
     always false and a sighted user got no required signal at all. Marking the
     exception is the whole point, and in the add-target wizard the exception is
     "required": one of its five fields is. `aria-hidden` because the control
     itself carries the real `aria-required`, so a screen reader would
     otherwise hear the asterisk twice. */
  .ui-field-required {
    margin-left: 0.15em;
    color: var(--color-danger);
    font-weight: var(--text-caption-weight);
  }

  .ui-field-control {
    display: flex;
    flex-direction: column;
  }

  .ui-field-help {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .ui-field-error {
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-small-size);
  }
</style>
