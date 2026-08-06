import { defineConfig } from 'vitest/config';

// Repo-root scripts (bundling, release packaging, ...) get their own tiny
// vitest project, same as every `packages/*`/`apps/*` — wired into the root
// `vitest.config.ts`'s `projects` list so `pnpm test` covers them too,
// instead of leaving `scripts/lib/*.mjs` as the one part of the build
// pipeline nothing ever runs against real esbuild output (issue #817).
export default defineConfig({
  test: {
    name: 'scripts',
    environment: 'node',
    include: ['**/*.test.mjs'],
  },
});
