<script lang="ts">
  /**
   * Displays a freshly generated Recovery Code trustworthily (SPEC §8 path 2
   * "recovery-code escrow"; issue #384): monospace (JetBrains Mono, SPEC.md
   * §4's "agent output, code" role — a Recovery Code is exactly the kind of
   * string a user must transcribe/compare character-by-character), a
   * copy-to-clipboard affordance, an explicit warning that this is the only
   * way to recover the account or add another device, and a FORCED
   * confirmation the user must actively engage before continuing: a real
   * checkbox that gates the continue button's `disabled` state, not a
   * decorative one that's checked but changes nothing — the button stays
   * disabled until it's actually ticked.
   *
   * Purely presentational: this component neither generates the code nor
   * escrows it (both are `OnboardingGate.svelte`'s job) — it only renders
   * `code` and reports the moment the user has confirmed they saved it.
   */
  import { copyToClipboard } from '$lib/copy';

  interface Props {
    /** The Recovery Code to display, already formatted for display (`@loombox/crypto`'s `generateRecoveryCode`, dash-grouped). */
    code: string;
    /** Fires once the user has ticked the confirmation checkbox and pressed Continue. */
    onConfirmed: () => void;
    /** True while the caller is escrowing this code (or otherwise busy) — disables Continue a second time and swaps its label. */
    busy?: boolean;
    /** An escrow/continue failure to surface, if any. */
    error?: string;
    /** Injectable for tests; defaults to the real clipboard write. */
    copyFn?: (text: string) => Promise<void>;
  }

  const { code, onConfirmed, busy = false, error, copyFn = copyToClipboard }: Props = $props();

  let confirmed = $state(false);
  let copied = $state(false);
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

  async function handleCopy(): Promise<void> {
    await copyFn(code);
    copied = true;
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copied = false;
    }, 1500);
  }

  function handleContinue(): void {
    if (!confirmed || busy) return;
    onConfirmed();
  }
</script>

<div class="recovery-code-card" data-testid="recovery-code-card">
  <p class="warning" role="alert">
    Save this Recovery Code somewhere safe. It is the <strong>only</strong> way to recover your account
    or add another device — loombox never stores it, and there is no other way to get it back.
  </p>

  <div class="code-row">
    <code class="code font-mono" data-testid="recovery-code-value">{code}</code>
    <button type="button" class="copy-button" onclick={handleCopy} data-testid="recovery-code-copy">
      {copied ? 'Copied' : 'Copy'}
    </button>
  </div>

  <label class="confirm-row">
    <input type="checkbox" bind:checked={confirmed} data-testid="recovery-code-confirm-checkbox" />
    I've saved my Recovery Code somewhere safe.
  </label>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <button
    type="button"
    class="continue-button"
    disabled={!confirmed || busy}
    onclick={handleContinue}
    data-testid="recovery-code-continue"
  >
    {busy ? 'Securing your account…' : 'Continue'}
  </button>
</div>

<style>
  .recovery-code-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    padding: var(--space-lg);
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-surface-raised);
  }

  .warning {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-warning);
    background: var(--color-warning-subtle);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
  }

  .code-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .code {
    flex: 1;
    padding: var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-fill-subtle);
    font-size: 1.05rem;
    letter-spacing: 0.05em;
    word-break: break-all;
    user-select: all;
  }

  .copy-button {
    flex-shrink: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    padding: var(--space-sm) var(--space-md);
    cursor: pointer;
    font-size: var(--text-small-size);
  }

  .copy-button:hover {
    background: var(--color-fill-subtle);
  }

  .confirm-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    font-size: var(--text-small-size);
    cursor: pointer;
  }

  .confirm-row input {
    width: 1.1rem;
    height: 1.1rem;
    cursor: pointer;
  }

  .continue-button {
    align-self: flex-start;
    border: none;
    border-radius: var(--radius-md);
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    padding: var(--space-sm) var(--space-lg);
    cursor: pointer;
    font-weight: 600;
  }

  .continue-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-small-size);
  }
</style>
