<script lang="ts">
  import { onMount } from 'svelte';
  import { pwaInfo } from 'virtual:pwa-info';
  import { useRegisterSW } from 'virtual:pwa-register/svelte';
  import '$lib/styles/tokens.css';
  import '$lib/styles/typography.css';
  import { themeStore } from '$lib/theme';

  interface Props {
    children?: import('svelte').Snippet;
  }

  const { children }: Props = $props();

  // Injects <link rel="manifest" ...> into the page head so the PWA is
  // installable; app.html can't reference a build-time path directly.
  const webManifestLink = $derived(pwaInfo ? pwaInfo.webManifest.linkTag : '');

  // Registers the generated service worker on the client. No update-prompt
  // UI here on purpose: this issue is the plumbing spike, not session UI.
  useRegisterSW({ immediate: true });

  // Design tokens' theme mechanism (issue #195): stamps the persisted (or
  // absent, i.e. "follow the system") theme preference onto <html> once,
  // client-side, before the rest of the app renders. See `$lib/theme.ts`'s
  // doc comment for how this interacts with `tokens.css`'s CSS-only
  // `prefers-color-scheme` fallback.
  onMount(() => {
    themeStore.init();
  });
</script>

<svelte:head>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html webManifestLink}
</svelte:head>

{@render children?.()}
