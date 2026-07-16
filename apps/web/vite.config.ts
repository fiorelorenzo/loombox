import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

// v0 PWA spike (SPEC §16): @vite-pwa/sveltekit wired with a minimal
// installable manifest + generated service worker. Session UI, offline
// data strategy, and push are out of scope here — this is plumbing only.
export default defineConfig({
  plugins: [
    sveltekit(),
    SvelteKitPWA({
      registerType: 'autoUpdate',
      // generateSW precaches the built assets; that's enough to be
      // installable and to survive a reload offline for this shell.
      strategies: 'generateSW',
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
