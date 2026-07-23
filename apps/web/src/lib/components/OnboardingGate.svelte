<script lang="ts">
  /**
   * First-run AMK onboarding (SPEC §8; issue #384), shown instead of the
   * cockpit whenever this browser has no local AMK for the signed-in
   * account — replacing the old silent `loadOrCreateAmk` call
   * `+page.svelte` used to make on every connect (every browser minting its
   * own independent AMK, so a second device just saw an empty "No sessions
   * yet.").
   *
   * Two explicit, equally discoverable paths (never one silently assumed):
   * - **First device**: generates the account's AMK client-side (WebCrypto)
   *   plus a Recovery Code, shows it via `RecoveryCodeCard` (copy + a FORCED
   *   confirmation), then hands `(amk, recoveryCode)` to `onFirstDevice` —
   *   the caller persists the AMK, connects, and escrows the code through
   *   that live connection (`RelayClient.escrowAmk`), since escrow needs an
   *   open socket this component deliberately doesn't own (see
   *   `+page.svelte`'s `escrowPendingRecoveryCode`).
   * - **New device**: enters a Recovery Code already saved from a prior
   *   device, resolved via the standalone `bootstrapAmkFromRecoveryCode`
   *   (no existing connection needed — SPEC §8's "no previously-trusted
   *   device online" path), then hands the full `BootstrapAmkResult` to
   *   `onNewDevice`.
   *
   * `bootstrapAmk` is injectable (defaults to the real
   * `bootstrapAmkFromRecoveryCode`) purely for hermetic component tests —
   * mirrors `CopyButton`'s `copyFn` pattern.
   */
  import { generateAmk, generateRecoveryCode } from '@loombox/crypto';
  import {
    bootstrapAmkFromRecoveryCode,
    type BootstrapAmkResult,
    type WebSocketConstructor,
  } from '$lib/relay-client';
  import RecoveryCodeCard from './RecoveryCodeCard.svelte';
  import RecoveryCodeEntryForm from './RecoveryCodeEntryForm.svelte';

  interface Props {
    accountId: string;
    relayUrl: string;
    authToken: string;
    onFirstDevice: (amk: Uint8Array, recoveryCode: string) => void;
    onNewDevice: (result: BootstrapAmkResult) => void;
    /** Injectable for tests; defaults to the real network bootstrap. */
    bootstrapAmk?: typeof bootstrapAmkFromRecoveryCode;
    /** WebSocket constructor override, forwarded to `bootstrapAmk`; tests inject a fake. */
    webSocketImpl?: WebSocketConstructor;
  }

  const {
    accountId,
    relayUrl,
    authToken,
    onFirstDevice,
    onNewDevice,
    bootstrapAmk = bootstrapAmkFromRecoveryCode,
    webSocketImpl,
  }: Props = $props();

  type Mode = 'choose' | 'first-device' | 'new-device';
  let mode = $state<Mode>('choose');

  // Generated once, the moment the user picks "first device" — not eagerly
  // on mount, so a returning-elsewhere user who picks "new device" instead
  // never has an unused AMK/code generated for nothing.
  let firstDeviceAmk = $state<Uint8Array | undefined>(undefined);
  let firstDeviceCode = $state<string | undefined>(undefined);
  let firstDeviceBusy = $state(false);
  let firstDeviceError = $state<string | undefined>(undefined);

  let newDeviceBusy = $state(false);
  let newDeviceError = $state<string | undefined>(undefined);

  function chooseFirstDevice(): void {
    firstDeviceAmk = generateAmk();
    firstDeviceCode = generateRecoveryCode();
    firstDeviceError = undefined;
    mode = 'first-device';
  }

  function chooseNewDevice(): void {
    newDeviceError = undefined;
    mode = 'new-device';
  }

  function backToChoice(): void {
    mode = 'choose';
    firstDeviceAmk = undefined;
    firstDeviceCode = undefined;
    firstDeviceError = undefined;
    newDeviceError = undefined;
  }

  function handleFirstDeviceConfirmed(): void {
    if (!firstDeviceAmk || !firstDeviceCode) return;
    // The parent takes it from here (persist + connect + escrow); this
    // component's job ends the moment it hands the pair over. `firstDeviceBusy`
    // stays true so a slow parent-side connect/escrow doesn't let the user
    // double-submit while this gate is still mounted.
    firstDeviceBusy = true;
    onFirstDevice(firstDeviceAmk, firstDeviceCode);
  }

  async function handleNewDeviceSubmit(code: string): Promise<void> {
    newDeviceBusy = true;
    newDeviceError = undefined;
    try {
      const result = await bootstrapAmk({
        relayUrl,
        accountId,
        authToken,
        recoveryCode: code,
        ...(webSocketImpl ? { webSocketImpl } : {}),
      });
      onNewDevice(result);
    } catch (error) {
      newDeviceError =
        error instanceof Error
          ? error.message
          : 'Could not recover your account with that Recovery Code.';
    } finally {
      newDeviceBusy = false;
    }
  }
</script>

<section class="onboarding-gate" data-testid="onboarding-gate">
  {#if mode === 'choose'}
    <h2>Set up this device</h2>
    <p class="intro">
      loombox encrypts every session end-to-end. This browser needs its own copy of your account's
      key before it can read anything.
    </p>
    <div class="choice-row">
      <button
        type="button"
        class="choice-card"
        onclick={chooseFirstDevice}
        data-testid="onboarding-choose-first-device"
      >
        <strong>This is my first device</strong>
        <span>Generate a new account key and a Recovery Code to add more devices later.</span>
      </button>
      <button
        type="button"
        class="choice-card"
        onclick={chooseNewDevice}
        data-testid="onboarding-choose-new-device"
      >
        <strong>I already have loombox on another device</strong>
        <span>Enter the Recovery Code you saved there to unlock this account here.</span>
      </button>
    </div>
  {:else if mode === 'first-device'}
    <h2>Save your Recovery Code</h2>
    <p class="intro">
      This code is the only way to add another device or recover your account if this one is lost.
    </p>
    {#if firstDeviceCode}
      <RecoveryCodeCard
        code={firstDeviceCode}
        busy={firstDeviceBusy}
        error={firstDeviceError}
        onConfirmed={handleFirstDeviceConfirmed}
      />
    {/if}
    {#if !firstDeviceBusy}
      <button type="button" class="back-link" onclick={backToChoice}>Back</button>
    {/if}
  {:else if mode === 'new-device'}
    <h2>Enter your Recovery Code</h2>
    <p class="intro">
      Paste or type the Recovery Code you saved when you set up your first device.
    </p>
    <RecoveryCodeEntryForm
      busy={newDeviceBusy}
      error={newDeviceError}
      submitLabel="Unlock this device"
      onSubmit={handleNewDeviceSubmit}
    />
    {#if !newDeviceBusy}
      <button type="button" class="back-link" onclick={backToChoice}>Back</button>
    {/if}
  {/if}
</section>

<style>
  .onboarding-gate {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    max-width: 32rem;
    margin: var(--space-2xl) auto;
    padding: var(--space-xl);
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
  }

  h2 {
    margin: 0;
  }

  .intro {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .choice-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .choice-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    text-align: left;
    padding: var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface-raised);
    color: inherit;
    cursor: pointer;
  }

  .choice-card:hover,
  .choice-card:focus-visible {
    border-color: var(--color-accent);
    background: var(--color-accent-subtle);
  }

  .choice-card span {
    font-size: var(--text-small-size);
    opacity: 0.75;
  }

  .back-link {
    align-self: flex-start;
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
    padding: 0;
    font-size: var(--text-small-size);
    text-decoration: underline;
  }
</style>
