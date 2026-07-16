import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // adapter-node: loombox's PWA client is served behind a Node server,
    // matching the relay-fronted deployment model used by pitchbox and
    // loombox-landing (Caddy -> node process on prodbox), see SPEC §10.1.
    adapter: adapter(),
  },
};

export default config;
