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
   *
   * Deck migration (redesign v2 design spec, issue #473): the visible card
   * composes the real `Card` primitive (`elevation="floating"`, since this
   * is the one thing the whole onboarding screen exists to make the user
   * look at) nested inside a plain, unstyled wrapper that keeps this
   * component's own `recovery-code-card` test id — `Card` hardcodes its own
   * `data-testid`, so it can't carry a caller-chosen one directly (see that
   * component's doc comment). The copy affordance now reuses the shared
   * `CopyButton` (rather than a second hand-rolled copy control) — its
   * accessible name is what the test queries via `getByRole` now, since
   * `CopyButton` doesn't take a `data-testid` override (unlike `Button`/
   * `IconButton`, issue #479), the same convention `MessageItem.svelte`
   * already established for composing it. Continue now composes the real
   * `Button` primitive via its `dataTestId` override so the existing
   * `recovery-code-continue` test id survives the move — `Button`'s own
   * `loading` state supplies the busy `WovenLoader` inline with the label
   * text. A busy escrow round trip additionally keeps a
   * `thread-draw-fill-loop` sweep under the button — the brief's
   * "thread-draw for the escrow/pairing in-flight state" (§6). The
   * escrow-failure message composes the real `ErrorNotice` primitive (no id
   * constraint on it from the existing test).
   */
  import Card from './ui/Card.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Button from './ui/Button.svelte';
  import CopyButton from './CopyButton.svelte';

  interface Props {
    /** The Recovery Code to display, already formatted for display (`@loombox/crypto`'s `generateRecoveryCode`, dash-grouped). */
    code: string;
    /** Fires once the user has ticked the confirmation checkbox and pressed Continue. */
    onConfirmed: () => void;
    /** True while the caller is escrowing this code (or otherwise busy) — disables Continue a second time and swaps its label. */
    busy?: boolean;
    /** An escrow/continue failure to surface, if any. */
    error?: string;
    /** Injectable for tests; forwarded to `CopyButton`'s own `copyFn` — defaults to the real clipboard write. */
    copyFn?: (text: string) => Promise<void>;
  }

  const { code, onConfirmed, busy = false, error, copyFn }: Props = $props();

  let confirmed = $state(false);

  function handleContinue(): void {
    if (!confirmed || busy) return;
    onConfirmed();
  }
</script>

<div class="recovery-code-card-shell" data-testid="recovery-code-card">
  <Card elevation="floating" padding="lg" class="recovery-code-card">
    <p class="warning" role="alert">
      Save this Recovery Code somewhere safe. It is the <strong>only</strong> way to recover your account
      or add another device — loombox never stores it, and there is no other way to get it back.
    </p>

    <div class="code-row">
      <code class="code font-mono" data-testid="recovery-code-value">{code}</code>
      <CopyButton text={code} label="Copy Recovery Code" {copyFn} />
    </div>

    <label class="confirm-row">
      <input
        type="checkbox"
        bind:checked={confirmed}
        data-testid="recovery-code-confirm-checkbox"
      />
      I've saved my Recovery Code somewhere safe.
    </label>

    {#if error}
      <ErrorNotice message={error} />
    {/if}

    <div class="continue-row">
      <Button
        type="button"
        variant="primary"
        loading={busy}
        disabled={!confirmed}
        onclick={handleContinue}
        dataTestId="recovery-code-continue"
      >
        {busy ? 'Securing your account…' : 'Continue'}
      </Button>
      {#if busy}
        <span class="in-flight-track" aria-hidden="true">
          <span class="thread-draw-fill-loop in-flight-bar"></span>
        </span>
      {/if}
    </div>
  </Card>
</div>

<style>
  /* Card renders its own outer element in its own component scope (see
     that file's `Card`-vs-`className` doc comment); `:global()` under this
     local ancestor class is the narrowly-scoped way to reach it, mirroring
     `EmptyState`'s own doc comment for the identical situation. */
  .recovery-code-card-shell :global(.recovery-code-card) {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
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
    flex-wrap: wrap;
  }

  .code {
    flex: 1;
    min-width: 0;
    padding: var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-fill-subtle);
    font-size: var(--text-title-size);
    letter-spacing: 0.05em;
    word-break: break-all;
    user-select: all;
  }

  .confirm-row input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
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

  .continue-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    align-items: flex-start;
  }

  /* thread-draw for the escrow in-flight state (redesign brief §6): a
     continuous sweep under Continue while the parent is escrowing this
     code with the relay. */
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
