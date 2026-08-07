import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Uses the plain @sveltejs/vite-plugin-svelte (not sveltekit()) plus a
// manual `$lib` alias. `sveltekit()`'s own svelte.config.js lookup resolves
// against process.cwd(), not this file's directory, which breaks it when
// this config is loaded as one of several vitest workspace `projects` from
// the monorepo root (see AGENTS.md / root vitest.config.ts).
export default defineConfig({
  root,
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: `${root}src/lib`,
      // #381: `+page.svelte` reads `$env/dynamic/public`, a SvelteKit
      // virtual module the plain `svelte()` plugin above doesn't provide
      // (see the doc comment above) — aliased to a local stand-in so
      // `svelte/server`'s `render()` in page.test.ts can still load it.
      '$env/dynamic/public': `${root}vitest-stubs/env-dynamic-public.ts`,
      // Issue #865: `SettingsPage.svelte` reads `$app/environment`'s
      // `version` — same "plain svelte() plugin has no real SvelteKit
      // virtual modules" gap as `$env/dynamic/public` just above.
      '$app/environment': `${root}vitest-stubs/app-environment.ts`,
    },
    // Component tests opt into `// @vitest-environment jsdom` per-file (see
    // e.g. CopyButton.test.ts); when they do, vite-plugin-svelte must also
    // compile Svelte components in their client (DOM) form rather than SSR
    // — otherwise `mount()` throws "not available on the server" even
    // though the test *is* running in jsdom. Gated on `VITEST` so this
    // never affects the real `vite build`.
    conditions: process.env.VITEST ? ['browser'] : undefined,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // relay-client.test.ts drives a real relay plus real crypto over real
    // WebSockets (issue #529); its wait helpers are event-driven (resolve
    // the instant a store/array/condition is satisfied, not on a poll
    // tick), so raising this costs nothing on a passing run — it only
    // widens how long a genuinely stuck run is given before vitest's own
    // generic "Test timed out" preempts the helpers' own, more specific
    // timeout errors.
    testTimeout: 15_000,
  },
});
