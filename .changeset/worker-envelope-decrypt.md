---
"@loombox/web": patch
---

Move session/project/target envelope decrypt+encrypt (SPEC §8) off the main thread into a bundled Web Worker, and batch a burst of same-tick envelopes into one `Promise.all` inside the worker's own message handler (issue #756, cockpit-parity decision E3-4).

`RelayClient` no longer holds the raw AMK or calls `crypto.subtle` directly for session traffic: `envelope-crypto-client.ts`'s `createEnvelopeCrypto` picks a worker-backed implementation in any real browser/Electron context (`typeof Worker !== 'undefined'`) and falls back to an in-process one only where no `Worker` global exists (Node/vitest). The AMK crosses to the worker exactly once, as a Transferable `ArrayBuffer` (a dedicated copy, not the caller's own array), detaching the main thread's copy immediately. The worker is loaded via a static, literal Vite `?worker` import — same-origin, bundled, no dynamic URL, no `eval` — and survives the PWA's `injectManifest` service-worker precaching with no `vite.config.ts` changes (its emitted chunk already matches the existing `client/**/*.js` glob, verified against a real production build).

A decrypt failure still surfaces exactly as before (the same `console.warn` call sites, unchanged); a corrupt envelope in a batch fails only its own slot, never the rest of the batch.
