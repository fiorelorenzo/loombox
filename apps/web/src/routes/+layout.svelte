<script lang="ts">
  import { browser } from '$app/environment';
  import { onMount } from 'svelte';
  import { pwaInfo } from 'virtual:pwa-info';
  import { useRegisterSW } from 'virtual:pwa-register/svelte';
  import '$lib/styles/tokens.css';
  import '$lib/styles/deck.css';
  import '$lib/styles/typography.css';
  import '$lib/styles/motion.css';
  import { themeStore } from '$lib/theme';
  import { accentStore } from '$lib/accent';
  import { expandThoughtsStore } from '$lib/expand-thoughts';
  import { pwaUpdateAvailable, registerServiceWorkerUpdater } from '$lib/pwa-update';

  interface Props {
    children?: import('svelte').Snippet;
  }

  const { children }: Props = $props();

  // Injects <link rel="manifest" ...> into the page head so the PWA is
  // installable; app.html can't reference a build-time path directly.
  const webManifestLink = $derived(pwaInfo ? pwaInfo.webManifest.linkTag : '');

  // Registers the generated service worker on the client. `onNeedRefresh`
  // (issue #657) is the only hook this needs: `registerType: 'prompt'`
  // (`vite.config.ts`) means vite-pwa never activates a waiting worker or
  // reloads on its own, it only calls this once one is ready. Flipping
  // `pwaUpdateAvailable` is what lets `+page.svelte` show
  // `UpdateAvailableToast` instead of the page silently swapping under
  // whoever's mid-session. The Electron desktop shell (apps/desktop) loads
  // this same app but its service-worker support breaks workbox's
  // auto-update postMessage (DataCloneError) and, worse, the SW's fetch
  // interception leaves the app hanging on startup, so skip registration
  // there and tear down any SW a prior load left behind. The offline/
  // installable PWA story is browser-only; the Electron shell instead
  // relies purely on `$lib/pwa-update.ts`'s other trigger, the
  // buildIdentity comparison, which needs no service worker at all.
  if (browser && navigator.userAgent.includes('Electron')) {
    void navigator.serviceWorker
      ?.getRegistrations?.()
      .then((registrations) => registrations.forEach((registration) => registration.unregister()))
      .catch(() => {});
  } else {
    const { updateServiceWorker } = useRegisterSW({
      immediate: true,
      onNeedRefresh() {
        pwaUpdateAvailable.set(true);
      },
    });
    registerServiceWorkerUpdater(updateServiceWorker);
  }

  // Design tokens' theme mechanism (issue #195): stamps the persisted (or
  // absent, i.e. "follow the system") theme preference onto <html> once,
  // client-side, before the rest of the app renders. See `$lib/theme.ts`'s
  // doc comment for how this interacts with `tokens.css`'s CSS-only
  // `prefers-color-scheme` fallback.
  //
  // The accent-theming mechanism (issue #376) is initialized right after —
  // it subscribes to `themeStore.preference` internally, so `theme.ts`'s
  // own `init()` must run first (it's what gives that store its real,
  // possibly-persisted starting value rather than the module's static
  // default).
  //
  // The "expand thoughts" preference (design spec
  // `2026-08-05-cockpit-v8-decisions.md` §2, decision B2-1, issue #709) has
  // no such ordering dependency — it's a plain persisted boolean, not
  // theme-derived — but it starts here too, for the same reason: every
  // `MessageItem` needs its real, possibly-persisted value before it first
  // renders a thought, not the module's static default.
  onMount(() => {
    themeStore.init();
    accentStore.init();
    expandThoughtsStore.init();
  });
</script>

<svelte:head>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html webManifestLink}
</svelte:head>

{@render children?.()}
