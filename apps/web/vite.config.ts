import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

// @vite-pwa/sveltekit wired with an installable manifest + service worker.
// `injectManifest` (not the v0 spike's original `generateSW`): push
// notifications (issues #162/#164, SPEC §7.11) need a custom
// `push`/`notificationclick` listener in the worker itself, which
// `generateSW`'s fully Workbox-generated file has no hook for — this builds
// `src/service-worker.ts` (our own code, with `self.__WB_MANIFEST` injected
// for precaching) instead of generating one from scratch.
export default defineConfig({
  plugins: [
    sveltekit(),
    SvelteKitPWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.ts',
      injectManifest: {
        // Precache only the built client bundle/assets, matching the v0
        // spike's original `generateSW` scope — offline data strategy
        // beyond "survive a reload" is still out of scope here.
        globPatterns: ['client/**/*.{js,css,ico,png,svg,webmanifest}'],
      },
      manifest: {
        name: 'loombox',
        short_name: 'loombox',
        description: 'Command your coding agents from anywhere.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0b0b12',
        theme_color: '#4f46e5',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
        ],
      },
      devOptions: {
        // Lets `vite dev` register a (disabled-cache) SW too, useful while
        // iterating; production behavior is unaffected.
        enabled: false,
      },
    }),
  ],
});
