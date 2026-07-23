import { defineConfig } from 'vitest/config';

// Test files here never import `electron` (see README.md's "why this
// package's tests never launch Electron") — `../main/index.ts`,
// `../main/window.ts`, `../main/tray.ts`, and `../preload/index.ts` are the
// only files that do, and none have a corresponding `.test.ts`, so plain
// `node` environment + no Electron runtime is all this needs.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
