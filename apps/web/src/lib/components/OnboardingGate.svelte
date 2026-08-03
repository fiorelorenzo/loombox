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
   *
   * Restyle (redesign brief `docs/design/redesign.md` §6, issue #430): the
   * "first impression" surface, so it earns the `floating` elevation tier
   * (§3). It is centred inside `GateShell`, which carries the brand lockup
   * above it — an earlier version drew its own dimmed `BrandMark` here too,
   * which made two marks on one screen. The `choose`/`first-device`/
   * `new-device` mode switch, previously an instant `if/else` swap, now gets the
   * `--duration-slow` "page-level narrative" crossfade (§2's motion table)
   * via a `{#key mode}`-scoped entrance animation — kept to a plain CSS
   * `animation` (not a Svelte `transition:`) deliberately, so a mode change
   * swaps the DOM synchronously (no delayed-outro races with this
   * component's existing synchronous test assertions) while still reading
   * as motion to a sighted user; `prefers-reduced-motion` support falls out
   * of `tokens.css`'s existing global `--duration-slow: 0ms` override, the
   * same mechanism every other primitive here relies on.
   *
   * Deck migration (redesign v2 design spec, issue #473): "Back" already
   * composed the real `Button` primitive. The two choice cards stay their
   * own hand-rolled compound elements (a bold title plus a description line,
   * `Card`'s `raised` tier, an accent-border hover) rather than importing
   * `Button` — the same call `AppearanceSettings.svelte`'s Theme/Accent
   * option buttons make: they're a selectable-option idiom, not a
   * plain call-to-action, so forcing them through `Button`'s single-line
   * variant styling would read as a different, worse control. `Button`'s
   * `dataTestId` override (issue #479) would let them keep their exact
   * `onboarding-choose-first-device`/`onboarding-choose-new-device` test ids
   * if that changes later, but the visual mismatch is the actual reason they
   * stay bespoke here.
   */
  import { generateAmk, generateRecoveryCode } from '@loombox/crypto';
  import {
    bootstrapAmkFromRecoveryCode,
    type BootstrapAmkResult,
    type WebSocketConstructor,
  } from '$lib/relay-client';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
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
  {#key mode}
    <div class="onboarding-step">
      {#if mode === 'choose'}
        <h2>Set up this device</h2>
        <p class="intro">
          loombox encrypts every session end-to-end. This browser needs its own copy of your
          account's key before it can read anything.
        </p>
        <div class="choice-row">
          <Card elevation="raised" padding="none" class="choice-card">
            <Button
              variant="ghost"
              fullWidth
              class="choice-card-trigger"
              onclick={chooseFirstDevice}
              dataTestId="onboarding-choose-first-device"
            >
              <span class="choice-card-copy">
                <strong>This is my first device</strong>
                <span
                  >Generate a new account key and a Recovery Code to add more devices later.</span
                >
              </span>
            </Button>
          </Card>
          <Card elevation="raised" padding="none" class="choice-card">
            <Button
              variant="ghost"
              fullWidth
              class="choice-card-trigger"
              onclick={chooseNewDevice}
              dataTestId="onboarding-choose-new-device"
            >
              <span class="choice-card-copy">
                <strong>I already have loombox on another device</strong>
                <span>Enter the Recovery Code you saved there to unlock this account here.</span>
              </span>
            </Button>
          </Card>
        </div>
      {:else if mode === 'first-device'}
        <h2>Save your Recovery Code</h2>
        <p class="intro">
          This code is the only way to add another device or recover your account if this one is
          lost.
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
          <Button variant="ghost" size="sm" class="back-link" onclick={backToChoice}>Back</Button>
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
          <Button variant="ghost" size="sm" class="back-link" onclick={backToChoice}>Back</Button>
        {/if}
      {/if}
    </div>
  {/key}
</section>

<style>
  /* floating tier (redesign brief §3): the one card nothing else competes
     with while it's on screen. */
  .onboarding-gate {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
    max-width: 32rem;
    margin: var(--space-2xl) auto;
    padding: var(--space-xl);
    border-radius: var(--radius-xl);
    border: 1px solid var(--color-border-strong);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-lg);
  }

  /* The dimmed `BrandMark` that used to be anchored here is gone: this card is
     centred inside `GateShell`, which already carries the full `BrandLockup`
     right above it, so the mark was the brand drawn a second time within one
     screen (the sign-in gate had the same duplication through `EmptyState`).
     The step content below is the only thing on this card now. */

  .onboarding-step {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    animation: onboarding-step-in var(--duration-slow) var(--ease-beat);
  }

  @keyframes onboarding-step-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  h2 {
    margin: 0;
    text-align: center;
  }

  .intro {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
    text-align: center;
  }

  .choice-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  /* `Card` supplies the raised-tier border/background/radius/shadow now
     (issue #579); the actual click target is the ghost `Button` filling it
     edge to edge. `overflow: hidden` keeps that button's own hover fill
     from spilling past the card's rounded corners. `:hover`/`:focus-within`
     rather than a synthetic `:has()` — `:hover` already bubbles up from a
     hovered descendant, and `:focus-within` is exactly that for keyboard
     focus, so the card tints without either side needing to know about
     the other. `:global()` because `Card`/`Button` render their own root
     in their own component scope. */
  :global(.choice-card) {
    padding: 0;
    overflow: hidden;
    transition:
      border-color var(--duration-fast) var(--ease-beat),
      background-color var(--duration-fast) var(--ease-beat);
  }

  :global(.choice-card:hover),
  :global(.choice-card:focus-within) {
    border-color: var(--color-accent);
    background: var(--color-accent-subtle);
  }

  /* tension-press (redesign brief §2) and the focus-visible ring both come
     from `Button`'s own base styling for free. */
  :global(.choice-card-trigger) {
    justify-content: flex-start;
    padding: var(--space-md);
    text-align: left;
    border-radius: 0;
  }

  :global(.choice-card-trigger:not(:disabled):hover) {
    text-decoration: none;
  }

  .choice-card-copy {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .choice-card-copy span {
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .onboarding-gate :global(.back-link) {
    align-self: flex-start;
  }
</style>
