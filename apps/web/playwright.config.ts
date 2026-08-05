import { defineConfig, devices } from '@playwright/test';

// Real end-to-end coverage for the PWA client (issue #192): builds the
// SvelteKit `adapter-node` output once and serves it via `vite preview`,
// then drives it in a real Chromium against a real, throwaway
// `@loombox/relay` instance + fake encrypted node each spec stands up
// itself (`tests-e2e/fixtures.ts`) — nothing about the app under test is
// stubbed. CI's `e2e` job (`.github/workflows/ci.yml`, `actions/setup-node` +
// `playwright install --with-deps chromium` on `ubuntu-latest`) is still the
// gate, but this suite ALSO runs on the devbox — Playwright's chromium is
// installed there and a spec takes seconds (measured: `pwa-shell.spec.ts`
// 4/4 in 20s), so it is the cheapest way to check a UI change here without
// the Electron app on the Mac (AGENTS.md, "Checking the PWA here,
// headless"). One caveat locally: `webServer` builds, and a build shares
// `.svelte-kit/` with a running `scripts/dev.sh`, so stop the dev loop
// first.
export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Serve the adapter-node build directly (its own server honours HOST/PORT
    // and binds to 127.0.0.1 as asked). `vite preview` defaulted to `localhost`
    // which resolves to ::1 on the CI runner, so a goto against the IPv4
    // baseURL got ERR_CONNECTION_REFUSED.
    command: 'pnpm run build && HOST=127.0.0.1 PORT=4173 node build/index.js',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
