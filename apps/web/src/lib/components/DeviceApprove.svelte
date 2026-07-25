<script lang="ts">
  import { untrack } from 'svelte';
  import WovenLoader from './WovenLoader.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import StatusDot from './ui/StatusDot.svelte';

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
   * Restyle (redesign brief §4/§6, issue #430): Approve/Deny are hand-rolled
   * to match `Button`'s `primary`/`secondary` look 1:1 (the existing test
   * queries fixed `device-approve-submit`/`device-deny-submit` ids `Button`
   * can't take), Approve gets a `thread-draw-fill-loop` sweep while busy —
   * this component IS the pairing surface the brief's "thread-draw for the
   * escrow/pairing in-flight state" (§6) names directly — the error
   * surfaces via the real `ErrorNotice` primitive, and the terminal
   * approved/denied states lead with a `StatusDot` (success/danger) per the
   * brief's "StatusDot for state."
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
      <button
        type="submit"
        class="approve-button"
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
        class="deny-button"
        disabled={userCode.trim() === '' || busy}
        onclick={handleDeny}
        data-testid="device-deny-submit"
      >
        Deny
      </button>
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

  /* primary Button look (redesign brief §4), hand-rolled — see file doc
     comment for why this can't just compose `Button`. */
  .approve-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
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

  .approve-button:not(:disabled):hover {
    background: var(--color-accent-hover);
  }

  .approve-button:not(:disabled):active {
    background: var(--color-accent-active);
    transform: scale(0.98);
  }

  /* secondary Button look (redesign brief §4). */
  .deny-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-primary);
    padding: var(--space-sm) var(--space-lg);
    cursor: pointer;
    font-weight: 600;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .deny-button:not(:disabled):hover {
    background: var(--color-fill-subtle);
  }

  .deny-button:not(:disabled):active {
    background: var(--color-fill);
    transform: scale(0.98);
  }

  .approve-button:focus-visible,
  .deny-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .approve-button:disabled,
  .deny-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
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
