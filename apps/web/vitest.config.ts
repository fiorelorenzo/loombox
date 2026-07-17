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
  },
});
