import { defineConfig } from '@playwright/test';

// Stub config: gives the e2e harness a home (tests-e2e/) ahead of real
// session-UI coverage, which lands with the PWA client epic. Not wired into
// CI yet and browsers are not installed on this box; `pnpm exec playwright
// test` is a local/CI-only entry point, not part of the unit `pnpm test`.
export default defineConfig({
  testDir: './tests-e2e',
  webServer: {
    command: 'pnpm preview',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:4173',
  },
});
