import { defineConfig, devices } from '@playwright/test';
import { e2ePreviewOrigin, e2ePreviewPort } from './tests-e2e/harness/e2e-port';

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
// headless").
//
// Two caveats, both shared-mutable-state, both worth knowing before you
// hit them (an agent that hits one usually hits the other):
//   - The preview port comes from `harness/e2e-port.ts`, derived per
//     checkout so parallel worktrees never collide or, worse, silently
//     attach to each other's build (#917) — see that file for the details.
//   - `webServer` builds, and a build shares `.svelte-kit/` *within this
//     same checkout* with a running `scripts/dev.sh`, so stop the dev loop
//     first. The port fix above doesn't touch this one: it's a directory,
//     not a port.
const port = e2ePreviewPort();
const baseURL = e2ePreviewOrigin();

export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL,
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
    command: `pnpm run build && HOST=127.0.0.1 PORT=${port} node build/index.js`,
    url: baseURL,
    // Never reuse whatever's already listening on the port, even though the
    // per-checkout derivation above already makes a same-port collision
    // between two checkouts astronomically unlikely: a loud EADDRINUSE bind
    // failure beats a silent pass against a build this checkout never made
    // (#917). CI already ran with this effectively off (`!process.env.CI`
    // was always false there); making it unconditional changes nothing
    // about the CI job.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
