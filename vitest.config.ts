import { defineConfig } from 'vitest/config';

// Root Vitest config. `projects` fans out to each package's own vitest.config.ts
// so `pnpm test` runs the whole workspace in one pass with unified coverage,
// while `pnpm -r test` runs each package independently.
export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'packages/providers/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: ['{packages,apps}/**/src/**/*.ts'],
      exclude: ['**/*.{test,spec}.ts', '**/index.ts'],
    },
  },
});
