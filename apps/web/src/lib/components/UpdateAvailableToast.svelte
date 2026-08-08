<script lang="ts">
  /**
   * The "a new version of loombox is ready" notice (issue #657's PWA half).
   * Replaces the previous silent behavior, `vite-plugin-pwa`'s
   * `registerType: 'autoUpdate'` used to call a bare
   * `window.location.reload()` the instant a new service worker activated,
   * and a tab that never triggers a browser service-worker update check at
   * all during a long, no-navigation session (this app's normal shape) got
   * no signal whatsoever even after the relay it is talking to moved on,
   * with a plain, dismissible toast. `+page.svelte`'s own `staleBuild`
   * `$derived` decides WHEN this renders (see `$lib/pwa-update.ts`'s doc
   * comment for the two triggers that feed it); this component only ever
   * renders the notice and reports the two things a person can do about
   * it. Reload is always a deliberate click, never automatic, a forced
   * reload mid-turn would be worse than the drift itself (#657's own
   * framing), so the worst this toast can do to an in-progress turn is sit
   * on screen until it's dismissed or acted on.
   */
  import Icon from './icons/Icon.svelte';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';

  interface Props {
    onReload: () => void;
    onDismiss: () => void;
  }

  const { onReload, onDismiss }: Props = $props();
</script>

<div class="update-toast" data-testid="update-available-toast" role="status">
  <span class="update-toast-copy">A new version of loombox is ready.</span>
  <div class="update-toast-actions">
    <Button size="sm" onclick={onReload} dataTestId="update-toast-reload">Reload</Button>
    <IconButton label="Dismiss" size="sm" onclick={onDismiss} dataTestId="update-toast-dismiss">
      <Icon name="close" />
    </IconButton>
  </div>
</div>

<style>
  .update-toast {
    /* `--z-toast` (tokens.css): declared for exactly this kind of surface,
       unused before this component. Fixed at every width, a toast has no
       in-flow position by definition, with a `bottom` floor that clears
       the permanent status bar always, and the mobile tabbar too under the
       same `max-width: 1023px` breakpoint `StatusBar.svelte`'s own fixed
       positioning switches on (`+page.svelte`'s `.tabbar` claims the
       window's true bottom edge there). */
    position: fixed;
    right: var(--space-lg);
    bottom: calc(var(--statusbar-height) + var(--space-lg));
    z-index: var(--z-toast);
    display: flex;
    align-items: center;
    gap: var(--space-md);
    max-width: min(24rem, calc(100vw - 2 * var(--space-lg)));
    padding: var(--space-md) var(--space-lg);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }

  .update-toast-copy {
    color: var(--color-text-primary);
    font-size: var(--text-small-size);
  }

  .update-toast-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-shrink: 0;
  }

  @media (max-width: 1023px) {
    .update-toast {
      bottom: calc(var(--tabbar-height) + var(--statusbar-height) + var(--space-lg));
    }
  }

  /* 390px (issue #265's own verification bar): below the mobile breakpoint
     the toast spans edge-to-edge instead of floating as a narrow card, and
     stacks the copy above the actions rather than squeezing both onto one
     row, the same overflow discipline every other 390px-proven surface in
     this codebase applies. */
  @media (max-width: 480px) {
    .update-toast {
      right: var(--space-sm);
      left: var(--space-sm);
      max-width: none;
      flex-direction: column;
      align-items: stretch;
    }

    .update-toast-actions {
      justify-content: flex-end;
    }
  }
</style>
