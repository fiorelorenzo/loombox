import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['../../scripts/check-worktree-leak.mjs'],
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // This package has genuinely timing/race-sensitive integration tests: real
    // spawned PTYs, cross-node session-lease arbitration through a live relay,
    // and permission round-trips. They pass reliably but occasionally lose a
    // race under CI load, so retry a failing test a couple of times before
    // failing the run. A deterministic failure still fails all attempts, so
    // this rescues flakes without masking a real regression.
    retry: 2,
  },
});
