<script lang="ts">
  import { untrack } from 'svelte';
  import WovenLoader from './WovenLoader.svelte';

  /**
   * The device-authorization approval card (issue #387's `/device` route):
   * a signed-in operator confirms the short `user_code` a resident node
   * printed, then Approves (or Denies) it — the "gh auth login"-shaped
   * browser half of the flow. Purely presentational + submit callbacks
   * (mirrors `RecoveryCodeEntryForm.svelte`'s own division of labor): the
   * caller (`routes/device/+page.svelte`) owns the actual relay call and
   * thus owns `busy`/`outcome`, so this stays trivially testable without a
   * relay.
   */
  interface Props {
    /** Pre-filled from `?user_code=`, if the node's `verification_uri_complete` was followed; still editable. */
    initialUserCode?: string;
    onApprove: (userCode: string) => void;
    onDeny: (userCode: string) => void;
    /** True while the caller has an approve/deny call in flight — disables the input and both buttons. */
    busy?: boolean;
    /** Set once a call has settled — renders the terminal state instead of the form. */
    outcome?: 'approved' | 'denied';
    /** A failure to surface (invalid/expired/already-used code, network error, ...). */
    error?: string;
  }

  const { initialUserCode = '', onApprove, onDeny, busy = false, outcome, error }: Props = $props();

  // Seeds the editable field from `initialUserCode` once, on mount — never
  // re-syncs on a later prop change (there is none in practice, the caller
  // sets this once from `?user_code=`), so `untrack` here is deliberate,
  // same as `MessageItem.svelte`'s own "capture the initial value only" use.
  let userCode = $state(untrack(() => initialUserCode));

  function handleApprove(event: Event): void {
    event.preventDefault();
    const trimmed = userCode.trim();
    if (trimmed === '' || busy) return;
    onApprove(trimmed);
  }

  function handleDeny(): void {
    const trimmed = userCode.trim();
    if (trimmed === '' || busy) return;
    onDeny(trimmed);
  }
</script>

{#if outcome === 'approved'}
  <div class="device-approve-outcome" data-testid="device-approve-outcome-approved">
    <p>This device is linked to your account.</p>
    <p class="hint">You can close this tab and return to the node.</p>
  </div>
{:else if outcome === 'denied'}
  <div class="device-approve-outcome" data-testid="device-approve-outcome-denied">
    <p>Request denied.</p>
    <p class="hint">The node was not linked to your account.</p>
  </div>
{:else}
  <form class="device-approve-form" onsubmit={handleApprove}>
    <label for="device-user-code-input">Code shown on the device</label>
    <input
      id="device-user-code-input"
      type="text"
      class="font-mono"
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      placeholder="XXXX-XXXX"
      bind:value={userCode}
      disabled={busy}
      data-testid="device-user-code-input"
    />
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    <div class="device-approve-actions">
      <button
        type="submit"
        disabled={userCode.trim() === '' || busy}
        data-testid="device-approve-submit"
      >
        {#if busy}
          <WovenLoader label="Linking" />
          Linking…
        {:else}
          Approve
        {/if}
      </button>
      <button
        type="button"
        class="secondary"
        disabled={userCode.trim() === '' || busy}
        onclick={handleDeny}
        data-testid="device-deny-submit"
      >
        Deny
      </button>
    </div>
  </form>
{/if}

<style>
  .device-approve-form {
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
    font-size: 1.1rem;
    letter-spacing: 0.08em;
    text-align: center;
    text-transform: uppercase;
  }

  input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  .device-approve-actions {
    display: flex;
    gap: var(--space-sm);
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-xs);
    border: none;
    border-radius: var(--radius-md);
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    padding: var(--space-sm) var(--space-lg);
    cursor: pointer;
    font-weight: 600;
  }

  button:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  button.secondary {
    background: var(--color-fill-subtle);
    color: inherit;
    border: 1px solid var(--color-border);
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

  .device-approve-outcome {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .device-approve-outcome p {
    margin: 0;
  }

  .hint {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }
</style>
