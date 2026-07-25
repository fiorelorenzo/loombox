<script lang="ts">
  import WovenLoader from './WovenLoader.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';

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
   * Restyle (redesign brief §4/§6, issue #430): the submit button is
   * hand-rolled to match `Button`'s `primary` look 1:1 rather than
   * importing it (the existing test queries a fixed
   * `recovery-code-entry-submit` id `Button` can't take), gets a
   * `thread-draw-fill-loop` sweep while busy (the brief's "thread-draw for
   * the escrow/pairing in-flight state," §6), and the error surfaces via
   * the real `ErrorNotice` primitive.
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
  <label for="recovery-code-input">Recovery Code</label>
  <input
    id="recovery-code-input"
    type="text"
    class="font-mono"
    autocomplete="off"
    autocapitalize="characters"
    spellcheck="false"
    placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
    bind:value={code}
    disabled={busy}
    data-testid="recovery-code-input"
  />
  {#if error}
    <ErrorNotice message={error} />
  {/if}
  <div class="submit-row">
    <button
      type="submit"
      class="submit-button"
      disabled={code.trim() === '' || busy}
      data-testid="recovery-code-entry-submit"
    >
      {#if busy}
        <WovenLoader label="Verifying" />
        Verifying…
      {:else}
        {submitLabel}
      {/if}
    </button>
    {#if busy}
      <span class="in-flight-track" aria-hidden="true">
        <span class="thread-draw-fill-loop in-flight-bar"></span>
      </span>
    {/if}
  </div>
</form>

<style>
  .recovery-code-entry-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  label {
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  input {
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-fill-subtle);
    color: inherit;
    font-size: 0.95rem;
    letter-spacing: 0.04em;
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: 1px;
  }

  .submit-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    align-items: flex-start;
  }

  /* primary Button look (redesign brief §4), hand-rolled — see file doc
     comment for why this can't just compose `Button`. */
  .submit-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    padding: var(--space-sm) var(--space-lg);
    cursor: pointer;
    font-weight: 600;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .submit-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .submit-button:not(:disabled):hover {
    background: var(--color-accent-hover);
  }

  .submit-button:not(:disabled):active {
    background: var(--color-accent-active);
    transform: scale(0.98);
  }

  .submit-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
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
