<script lang="ts">
  import WovenLoader from './WovenLoader.svelte';

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
    <p class="error" role="alert">{error}</p>
  {/if}
  <button
    type="submit"
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
</form>

<style>
  .recovery-code-entry-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  label {
    font-size: var(--text-small-size);
    opacity: 0.8;
  }

  input {
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-fill-subtle);
    color: inherit;
    font-size: 0.95rem;
    letter-spacing: 0.04em;
  }

  input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  button:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    align-self: flex-start;
    border: none;
    border-radius: var(--radius-md);
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    padding: var(--space-sm) var(--space-lg);
    cursor: pointer;
    font-weight: 600;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-small-size);
  }
</style>
