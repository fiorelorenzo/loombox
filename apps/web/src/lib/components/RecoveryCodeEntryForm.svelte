<script lang="ts">
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Input from './ui/Input.svelte';
  import FormActions from './ui/FormActions.svelte';

  /**
   * A Recovery Code text entry + submit — the "new device" bootstrap half of
   * SPEC §8 path 2 (issue #384), and reused verbatim for the mismatched-AMK
   * re-pair affordance on the sessions list (`+page.svelte`'s
   * `sessionDecryptFailures` state): both need exactly this input + submit,
   * just wired to different callers/copy around it.
   *
   * Purely presentational + a submit callback: this component never calls
   * `bootstrapAmkFromRecoveryCode` itself — the caller owns that (and thus
   * owns `busy`/`error`), so it stays trivially testable without a relay.
   *
   * Deck migration (redesign v2 design spec, issue #473): the submit button
   * now composes the real `Button` primitive via its `dataTestId` override
   * (issue #479) so the existing `recovery-code-entry-submit` test id
   * survives the move — `Button`'s own `loading` state supplies the busy
   * `WovenLoader` inline with the label text, so this file no longer
   * renders one by hand. It still gets a `thread-draw-fill-loop` sweep
   * while busy (the brief's "thread-draw for the escrow/pairing in-flight
   * state," §6), and the error surfaces via the real `ErrorNotice`
   * primitive.
   *
   * Coherence v5 migration (design spec §1, issue #508): the label+input
   * pair now composes the shared `Field`/`Input` primitives (monospace, per
   * that primitive's own "path/host/command/identifier" rule — a recovery
   * code is exactly that) and the submit row moves onto `FormActions`
   * (`align="start"`, since this form's single button sits left-aligned,
   * not in a Dialog footer); the busy `in-flight-track` bar now sits as a
   * plain sibling below `FormActions` rather than nested inside it, since
   * it's a status indicator, not an action.
   */
  interface Props {
    /** Fires with the raw (un-normalized) text the user typed — `@loombox/crypto`'s `normalizeRecoveryCode` runs on the receiving end, so this form doesn't need to duplicate that logic to validate input shape. */
    onSubmit: (code: string) => void;
    /** True while the caller is bootstrapping — disables the input/button and swaps the button label. */
    busy?: boolean;
    /** A bootstrap failure to surface, if any (e.g. "wrong code"). */
    error?: string;
    /** The submit button's label when not busy. */
    submitLabel?: string;
  }

  const { onSubmit, busy = false, error, submitLabel = 'Continue' }: Props = $props();

  let code = $state('');

  function handleSubmit(event: Event): void {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed === '' || busy) return;
    onSubmit(trimmed);
  }
</script>

<form class="recovery-code-entry-form" onsubmit={handleSubmit}>
  <Field label="Recovery Code">
    {#snippet children({ id, describedBy, errorId, invalid, required })}
      <Input
        {id}
        {describedBy}
        {errorId}
        {invalid}
        {required}
        monospace
        bind:value={code}
        disabled={busy}
        autocomplete="off"
        autocapitalize="characters"
        spellcheck={false}
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
        dataTestId="recovery-code-input"
      />
    {/snippet}
  </Field>
  {#if error}
    <ErrorNotice message={error} />
  {/if}
  <FormActions align="start">
    <Button
      type="submit"
      variant="primary"
      loading={busy}
      disabled={code.trim() === ''}
      dataTestId="recovery-code-entry-submit"
    >
      {busy ? 'Verifying…' : submitLabel}
    </Button>
  </FormActions>
  {#if busy}
    <div class="in-flight-wrap">
      <span class="in-flight-track" aria-hidden="true">
        <span class="thread-draw-fill-loop in-flight-bar"></span>
      </span>
    </div>
  {/if}
</form>

<style>
  .recovery-code-entry-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  /* Breathing room from `FormActions`'s own bottom edge — this bar is a
     status indicator, not another action, so it sits outside the row. */
  .in-flight-wrap {
    margin-top: var(--space-2xs);
  }

  /* thread-draw for the bootstrap in-flight state (redesign brief §6). */
  .in-flight-track {
    display: block;
    width: 100%;
    max-width: 12rem;
    height: 2px;
    border-radius: var(--radius-full);
    background: var(--color-fill-subtle);
    overflow: hidden;
  }

  .in-flight-bar {
    display: block;
    height: 100%;
    background: var(--color-accent);
  }
</style>
