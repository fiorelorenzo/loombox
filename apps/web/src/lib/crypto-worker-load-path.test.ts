import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Asserts the worker's load path stays a literal, statically-bundled Vite
 * `?worker` import (issue #756) rather than a runtime-constructed URL —
 * this is the acceptance criterion's "worker load path... asserted by a
 * test that would fail if it became dynamic". Verified empirically against
 * this exact repo's `vite@8.1.5` (see `crypto-worker.ts`'s doc comment):
 * `?worker` requires a literal import specifier to discover and bundle a
 * same-origin, hashed worker chunk at build time — a computed specifier
 * (`import(someUrl + '?worker')`, `new Worker(new URL(...))`, a CDN URL,
 * `eval`, etc.) is invisible to Vite's static analysis and would silently
 * stop emitting that chunk, which is exactly the failure mode a runtime
 * check could never catch (the code would still run today, against
 * yesterday's already-built chunk) but this source-level assertion does.
 */
describe('crypto-worker load path (issue #756)', () => {
  it('envelope-crypto-client.ts imports the worker via a literal `?worker` specifier', () => {
    const source = readFileSync(join(here, 'envelope-crypto-client.ts'), 'utf8');
    expect(source).toMatch(/^import CryptoWorker from '\.\/crypto-worker\?worker';$/m);
  });

  it('constructs the worker with no arguments — no URL, string, or expression is passed to the `?worker` factory', () => {
    const source = readFileSync(join(here, 'envelope-crypto-client.ts'), 'utf8');
    expect(source).toMatch(/new CryptoWorker\(\)/);
  });

  it("never falls back to `new Worker(` with a computed URL anywhere in this app's client code", () => {
    const source = readFileSync(join(here, 'envelope-crypto-client.ts'), 'utf8');
    expect(source).not.toMatch(/new Worker\(/);
  });

  it('the worker source itself never calls eval/Function or fetches a remote script', () => {
    const source = readFileSync(join(here, 'crypto-worker.ts'), 'utf8');
    expect(source).not.toMatch(/\beval\(/);
    expect(source).not.toMatch(/new Function\(/);
    expect(source).not.toMatch(/importScripts\(/); // classic-worker remote-script loading — this worker is bundled, not composed at runtime
    expect(source).not.toMatch(/https?:\/\//); // no CDN/remote URL of any kind
  });
});
