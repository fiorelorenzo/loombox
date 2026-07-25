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
    serviceWorker: {
      // SvelteKit auto-registers `src/service-worker.ts` by default via an
      // injected `navigator.serviceWorker.register(...)` script in the page.
      // That runs independently of app code (and of vite-pwa's injectRegister),
      // so it re-registered the SW even inside the Electron desktop shell,
      // where the SW breaks workbox's postMessage and hangs the app on
      // startup. Turn it off; registration is done explicitly (and gated for
      // Electron) via useRegisterSW in +layout.svelte.
      register: false,
    },
    typescript: {
      // SvelteKit's generated tsconfig only auto-includes `test/`/`tests/`
      // (see its own `include` list), not the Playwright suite's
      // `tests-e2e/` (issue #192) or the root `playwright.config.ts` —
      // without this, `svelte-check`/`pnpm --filter @loombox/web
      // typecheck` would silently skip both.
      config: (config) => {
        config.include = [
          ...(config.include ?? []),
          '../tests-e2e/**/*.ts',
          '../playwright.config.ts',
        ];
        return config;
      },
    },
  },
};

export default config;
