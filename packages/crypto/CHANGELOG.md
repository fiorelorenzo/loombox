# @loombox/crypto

## 0.0.1

### Patch Changes

- a36e07a: Make the package's base64 codec `Buffer`-free. `session-envelope.ts`'s `openJson`/`sealJson` — the path a browser client takes to open every session's private metadata, every session update and every permission request — called `Buffer.from(...)`, which Vite does not polyfill for the browser build, so the shipped PWA threw `Buffer is not defined` on every decrypt and rendered the mismatched-key state for a perfectly valid AMK. `amk-handoff.ts`, `pairing.ts` and `recovery-escrow.ts` now share the same `btoa`/`atob` codec, and `browser-safety.test.ts` forbids `Buffer` the way it already forbids `node:crypto`. Wire encoding is unchanged and pinned byte-for-byte against Node's own encoder.
- Updated dependencies [c0d6291]
- Updated dependencies [c86aa72]
- Updated dependencies [8f305d0]
- Updated dependencies [fcb76fc]
  - @loombox/protocol@0.1.0
