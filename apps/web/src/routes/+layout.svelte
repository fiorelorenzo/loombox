<script lang="ts">
  import { pwaInfo } from 'virtual:pwa-info';
  import { useRegisterSW } from 'virtual:pwa-register/svelte';

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
</script>

<svelte:head>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html webManifestLink}
</svelte:head>

{@render children?.()}
