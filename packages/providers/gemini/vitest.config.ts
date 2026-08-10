import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['../../../scripts/check-worktree-leak.mjs'],
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
