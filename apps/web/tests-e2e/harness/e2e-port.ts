import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * The e2e preview server's port and origin, derived from *this file's own*
 * absolute path rather than hardcoded (issue #917).
 *
 * We routinely have dozens of worktrees checked out under
 * `.claude/worktrees/` with agents running this suite in parallel. A fixed
 * port either collides outright, or — worse — `reuseExistingServer` sees
 * something already listening on it and silently adopts a sibling
 * worktree's server, skipping this checkout's own `pnpm run build`
 * entirely and reporting a green run for code it never compiled.
 *
 * Hashing this file's absolute path gives every checkout (this repo root,
 * every `.claude/worktrees/<name>` worktree, a CI runner's single clone)
 * a different, but stable-for-that-checkout, port — no config file or env
 * var required, nothing to remember. `playwright.config.ts` and
 * `harness/relay-harness.ts` both import this so the preview server, its
 * `baseURL`, and the relay's trusted origin can never drift apart.
 *
 * This alone makes a same-port collision between two checkouts astronomically
 * unlikely, but not impossible — `playwright.config.ts` additionally sets
 * `reuseExistingServer: false` unconditionally, so even a hash collision
 * fails loudly (`EADDRINUSE`) instead of silently testing the wrong build.
 *
 * Deliberately unrelated to the *other* shared-mutable-state caveat in
 * `playwright.config.ts`'s own header comment: a `webServer` build writes
 * `.svelte-kit/`, which a `scripts/dev.sh` running in the *same* checkout
 * also writes to. That one is intra-checkout (stop the dev loop first) and
 * this port derivation can't fix it, since it's a directory, not a port.
 */
const PORT_RANGE_START = 20000;
// 20000-39999: clear of vite dev (5173), the old fixed preview port (4173),
// the relay's ws port (8790), and Chrome's remote-debugging port (9222).
const PORT_RANGE_SIZE = 20000;

function stableCheckoutPort(): number {
  const thisFile = fileURLToPath(import.meta.url);
  const digest = createHash('sha256').update(thisFile).digest();
  return PORT_RANGE_START + (digest.readUInt32BE(0) % PORT_RANGE_SIZE);
}

/** Memoized: it's a pure function of this file's path, computed once per process. */
let cachedPort: number | undefined;

export function e2ePreviewPort(): number {
  cachedPort ??= stableCheckoutPort();
  return cachedPort;
}

export function e2ePreviewOrigin(): string {
  return `http://127.0.0.1:${e2ePreviewPort()}`;
}
