<script lang="ts">
  import { browser } from '$app/environment';
  import { onMount } from 'svelte';
  import { pwaInfo } from 'virtual:pwa-info';
  import { useRegisterSW } from 'virtual:pwa-register/svelte';
  import '$lib/styles/tokens.css';
  import '$lib/styles/typography.css';
  import { themeStore } from '$lib/theme';
  import { accentStore } from '$lib/accent';

  interface Props {
    children?: import('svelte').Snippet;
  }

  const { children }: Props = $props();

  // Injects <link rel="manifest" ...> into the page head so the PWA is
  // installable; app.html can't reference a build-time path directly.
  const webManifestLink = $derived(pwaInfo ? pwaInfo.webManifest.linkTag : '');

  // Registers the generated service worker on the client. No update-prompt
  // UI here on purpose: this issue is the plumbing spike, not session UI.
  // The Electron desktop shell (apps/desktop) loads this same app but its
  // service-worker support breaks workbox's auto-update postMessage
  // (DataCloneError) and, worse, the SW's fetch interception leaves the app
  // hanging on startup, so skip registration there and tear down any SW a
  // prior load left behind. The offline/installable PWA story is browser-only.
  if (browser && navigator.userAgent.includes('Electron')) {
    void navigator.serviceWorker
      ?.getRegistrations?.()
      .then((registrations) => registrations.forEach((registration) => registration.unregister()))
      .catch(() => {});
  } else {
    useRegisterSW({ immediate: true });
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
  onMount(() => {
    themeStore.init();
    accentStore.init();
  });
</script>

<svelte:head>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html webManifestLink}
</svelte:head>

{@render children?.()}
