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
   * carries the same meaning for screen readers).
   *
   * Deck migration (redesign v2 §2 "One button language"/"Consistency
   * sweep", issue #472): the enable button now routes through the shared
   * `Button` primitive (`primary`) using its `dataTestId` override (issue
   * #460, which is what unblocks this — `Button` used to hardcode
   * `data-testid="ui-button"` with no way to keep this component's existing
   * `data-testid="push-enable"`), and the subscribe-error message now
   * renders through the shared `ErrorNotice`, in place of the two
   * hand-rolled lookalikes this file used to maintain. The bell glyph stays
   * a hand-rolled inline SVG: the shared bespoke icon set
   * (`$lib/components/icons/icon-paths.ts`) doesn't have a bell/notification
   * glyph yet, and that file is outside this issue's scope, so there is no
   * shared `Icon` to route through here without inventing one out of scope.
   */
  import {
    pushSupportState,
    subscribeToPush,
    type PushSupportState,
  } from '$lib/push-notifications';
  import Button from './ui/Button.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
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
    <Button variant="primary" loading={subscribing} onclick={enable} dataTestId="push-enable">
      {#if !subscribing}
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
    </Button>
  {/if}
  {#if error}
    <ErrorNotice message={error} />
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
</style>
