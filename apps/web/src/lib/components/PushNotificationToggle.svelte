<script lang="ts">
  /**
   * The notifications permission/subscribe affordance (SPEC §7.11, issue
   * #162): a single button the user clicks — permission is never requested
   * unconditionally on load ("an appropriate, non-intrusive point"). Renders
   * one of four states (`pushSupportState`'s own vocabulary): unsupported,
   * not-yet-asked (the enable button), denied (a muted explanation, no
   * button — the browser itself owns un-denying), or granted/subscribed.
   */
  import {
    pushSupportState,
    subscribeToPush,
    type PushSupportState,
  } from '$lib/push-notifications';

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
    <span class="muted" data-testid="push-unsupported"
      >Push notifications aren't supported in this browser.</span
    >
  {:else if support === 'denied'}
    <span class="muted" data-testid="push-denied"
      >Notifications are blocked — enable them in your browser's site settings.</span
    >
  {:else if support === 'granted'}
    <span class="muted" data-testid="push-granted">Notifications on</span>
  {:else}
    <button type="button" data-testid="push-enable" disabled={subscribing} onclick={enable}>
      {subscribing ? 'Enabling…' : 'Enable notifications'}
    </button>
  {/if}
  {#if error}
    <span class="error" role="alert" data-testid="push-error">{error}</span>
  {/if}
</div>

<style>
  .push-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    font-size: 0.8rem;
  }

  .muted {
    opacity: 0.6;
  }

  .error {
    color: var(--color-danger);
  }

  button {
    font: inherit;
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
