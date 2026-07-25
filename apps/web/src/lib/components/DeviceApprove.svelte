<script lang="ts">
  import { untrack } from 'svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import Button from './ui/Button.svelte';

  /**
   * The device-authorization approval card (issue #387's `/device` route):
   * a signed-in operator confirms the short `user_code` a resident node
   * printed, then Approves (or Denies) it — the "gh auth login"-shaped
   * browser half of the flow. Purely presentational + submit callbacks
   * (mirrors `RecoveryCodeEntryForm.svelte`'s own division of labor): the
   * caller (`routes/device/+page.svelte`) owns the actual relay call and
   * thus owns `busy`/`outcome`, so this stays trivially testable without a
   * relay.
   *
   * Deck migration (redesign v2 design spec, issue #473): Approve/Deny now
   * compose the real `Button` primitive (`primary`/`secondary`) via its
   * `dataTestId` override (issue #479) so the existing
   * `device-approve-submit`/`device-deny-submit` test ids survive the move
   * — `Button`'s own `loading` state supplies the busy `WovenLoader` inline
   * with the label text, so this file no longer renders one by hand.
   * Approve additionally keeps a `thread-draw-fill-loop` sweep while busy —
   * this component IS the pairing surface the brief's "thread-draw for the
   * escrow/pairing in-flight state" names directly — the error surfaces via
   * the real `ErrorNotice` primitive, and the terminal approved/denied
   * states lead with a `StatusDot` (success/danger) per the brief's
   * "StatusDot for state."
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
    <StatusDot tone="success" size="md" label="Linked" />
    <div class="device-approve-outcome-copy">
      <p>This device is linked to your account.</p>
      <p class="hint">You can close this tab and return to the node.</p>
    </div>
  </div>
{:else if outcome === 'denied'}
  <div class="device-approve-outcome" data-testid="device-approve-outcome-denied">
    <StatusDot tone="danger" size="md" label="Denied" />
    <div class="device-approve-outcome-copy">
      <p>Request denied.</p>
      <p class="hint">The node was not linked to your account.</p>
    </div>
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
      <ErrorNotice message={error} />
    {/if}
    <div class="device-approve-actions">
      <Button
        type="submit"
        variant="primary"
        loading={busy}
        disabled={userCode.trim() === ''}
        dataTestId="device-approve-submit"
      >
        {busy ? 'Linking…' : 'Approve'}
      </Button>
      <Button
        type="button"
        variant="secondary"
        disabled={userCode.trim() === '' || busy}
        onclick={handleDeny}
        dataTestId="device-deny-submit"
      >
        Deny
      </Button>
    </div>
    {#if busy}
      <span class="in-flight-track" aria-hidden="true">
        <span class="thread-draw-fill-loop in-flight-bar"></span>
      </span>
    {/if}
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
    color: var(--color-text-secondary);
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
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: 1px;
  }

  .device-approve-actions {
    display: flex;
    gap: var(--space-sm);
  }

  /* thread-draw for the pairing in-flight state (redesign brief §6): this
     component IS the escrow/pairing surface the brief names directly. */
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

  .device-approve-outcome {
    display: flex;
    align-items: flex-start;
    gap: var(--space-sm);
  }

  .device-approve-outcome-copy {
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
