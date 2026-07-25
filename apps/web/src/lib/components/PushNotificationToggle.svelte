<script lang="ts">
  /**
   * The notifications permission/subscribe affordance (SPEC §7.11, issue
   * #162): a single button the user clicks — permission is never requested
   * unconditionally on load ("an appropriate, non-intrusive point"). Renders
   * one of four states (`pushSupportState`'s own vocabulary): unsupported,
   * not-yet-asked (the enable button), denied (a muted explanation, no
   * button — the browser itself owns un-denying), or granted/subscribed.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §4/§5/§6,
   * issue #434): each state gets a small hand-drawn bell glyph (matching
   * the brief's 20x20/1.5px-stroke icon system) and a `StatusDot` for
   * at-a-glance state (never as the only signal — the text label always
   * carries the same meaning for screen readers). The enable button is
   * hand-styled to `Button`'s `primary` visual language rather than
   * importing `Button` itself, because `Button` hardcodes its own
   * `data-testid` ("ui-button") with no override, and this component's
   * tests depend on the existing `data-testid="push-enable"` staying on
   * the actual interactive element. The error state keeps its own
   * `role="alert"`/`data-testid="push-error"` span, hand-styled to
   * `ErrorNotice`'s danger-tinted look for the same reason.
   */
  import {
    pushSupportState,
    subscribeToPush,
    type PushSupportState,
  } from '$lib/push-notifications';
  import WovenLoader from './WovenLoader.svelte';
  import StatusDot from './ui/StatusDot.svelte';

  interface Props {
    relayBaseUrl: string;
    authToken: string;
    deviceId: string;
    /** Injectable for tests; defaults to the real subscribe flow. */
    subscribeFn?: typeof subscribeToPush;
    /** Injectable for tests; defaults to the real feature/permission read. */
    supportStateFn?: typeof pushSupportState;
  }

  const {
    relayBaseUrl,
    authToken,
    deviceId,
    subscribeFn = subscribeToPush,
    supportStateFn = pushSupportState,
  }: Props = $props();

  // Read once at mount, not kept live via `$derived` — this is deliberately
  // a one-shot initial read (permission/feature support does not change
  // reactively out from under an open tab in any way this component needs
  // to track), and `support` must stay a plain mutable `$state` afterward
  // so `enable()` below can update it locally after a subscribe attempt.
  function initialSupportState(): PushSupportState {
    return supportStateFn();
  }

  let support = $state<PushSupportState>(initialSupportState());
  let subscribing = $state(false);
  let error = $state<string | undefined>(undefined);

  async function enable(): Promise<void> {
    error = undefined;
    subscribing = true;
    try {
      const result = await subscribeFn({ relayBaseUrl, authToken, deviceId });
      if (result.status === 'subscribed') {
        support = 'granted';
      } else if (result.status === 'permission-denied') {
        support = 'denied';
      } else if (result.status === 'unsupported') {
        support = 'unsupported';
      } else if (result.status === 'push-disabled-on-relay') {
        error = 'This relay has not enabled push notifications.';
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      subscribing = false;
    }
  }
</script>

<div class="push-toggle" data-testid="push-toggle">
  {#if support === 'unsupported'}
    <span class="push-state push-state-muted" data-testid="push-unsupported">
      <span class="push-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
          <path
            d="M5 8a5 5 0 0 1 10 0v3.2l1.4 2.3H3.6L5 11.2Z"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          <path d="M8.2 16a1.9 1.9 0 0 0 3.6 0" stroke-linecap="round" />
          <path d="M3 3l14 14" stroke-linecap="round" />
        </svg>
      </span>
      <StatusDot tone="neutral" label="Push unsupported" size="sm" />
      Push notifications aren't supported in this browser.
    </span>
  {:else if support === 'denied'}
    <span class="push-state push-state-muted" data-testid="push-denied">
      <span class="push-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
          <path
            d="M5 8a5 5 0 0 1 10 0v3.2l1.4 2.3H3.6L5 11.2Z"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          <path d="M8.2 16a1.9 1.9 0 0 0 3.6 0" stroke-linecap="round" />
        </svg>
      </span>
      <StatusDot tone="warning" label="Push blocked" size="sm" />
      Notifications are blocked — enable them in your browser's site settings.
    </span>
  {:else if support === 'granted'}
    <span class="push-state push-state-muted" data-testid="push-granted">
      <span class="push-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
          <path
            d="M5 8a5 5 0 0 1 10 0v3.2l1.4 2.3H3.6L5 11.2Z"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          <path d="M8.2 16a1.9 1.9 0 0 0 3.6 0" stroke-linecap="round" />
        </svg>
      </span>
      <StatusDot tone="success" label="Push enabled" size="sm" />
      Notifications on
    </span>
  {:else}
    <button
      type="button"
      class="push-enable-button"
      data-testid="push-enable"
      disabled={subscribing}
      onclick={enable}
    >
      {#if subscribing}
        <WovenLoader size="sm" label="Enabling" />
      {:else}
        <span class="push-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
            <path
              d="M5 8a5 5 0 0 1 10 0v3.2l1.4 2.3H3.6L5 11.2Z"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            <path d="M8.2 16a1.9 1.9 0 0 0 3.6 0" stroke-linecap="round" />
          </svg>
        </span>
      {/if}
      {subscribing ? 'Enabling…' : 'Enable notifications'}
    </button>
  {/if}
  {#if error}
    <span class="push-error" role="alert" data-testid="push-error">{error}</span>
  {/if}
</div>

<style>
  .push-toggle {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-sm);
    font-size: var(--text-small-size);
  }

  .push-state {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
  }

  .push-state-muted {
    color: var(--color-text-secondary);
  }

  .push-icon {
    display: inline-flex;
    flex-shrink: 0;
    width: 1.1rem;
    height: 1.1rem;
  }

  .push-icon svg {
    width: 100%;
    height: 100%;
  }

  .push-enable-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    font: inherit;
    font-weight: 600;
    padding: var(--space-sm) var(--space-lg);
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    cursor: pointer;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .push-enable-button:not(:disabled):hover {
    background: var(--color-accent-hover);
  }

  /* tension-press (redesign brief §2): darken + scale(0.98) on press. */
  .push-enable-button:not(:disabled):active {
    background: var(--color-accent-active);
    transform: scale(0.98);
  }

  .push-enable-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .push-enable-button:disabled {
    opacity: 0.65;
    cursor: default;
  }

  .push-error {
    display: inline-flex;
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-md);
    background: var(--color-danger-subtle);
    border: 1px solid var(--color-danger);
    color: var(--color-danger);
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133), the same
     coarse-pointer convention `Button`/`CopyButton` already use. */
  @media (pointer: coarse) {
    .push-enable-button {
      min-height: 2.75rem;
    }
  }
</style>
