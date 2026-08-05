# @loombox/crypto

## 0.0.6

### Patch Changes

- 35f3924: Tracker records are addressed by project, not by session, so a project's tracker
  is readable when no agent session is running for it. Adds a project resource key
  to the AMK key tree (`['project', accountId, projectPath]`), re-addresses the
  four tracker record messages to `nodeId` + `projectPath`, and makes the node
  answer every request it receives rather than dropping unanswerable ones.
- Updated dependencies [35f3924]
  - @loombox/protocol@0.5.1

## 0.0.5

### Patch Changes

- Updated dependencies [a1038bf]
  - @loombox/protocol@0.5.0

## 0.0.4

### Patch Changes

- Updated dependencies [7606627]
- Updated dependencies [ebcf227]
  - @loombox/protocol@0.4.0

## 0.0.3

### Patch Changes

- Updated dependencies [535a2ee]
- Updated dependencies [99e3583]
- Updated dependencies [e05423a]
- Updated dependencies [635e20d]
  - @loombox/protocol@0.3.0

## 0.0.2

### Patch Changes

- Updated dependencies [5118b26]
- Updated dependencies [a449b22]
- Updated dependencies [c97a2cf]
  - @loombox/protocol@0.2.0

## 0.0.1

### Patch Changes

- a36e07a: Make the package's base64 codec `Buffer`-free. `session-envelope.ts`'s `openJson`/`sealJson` — the path a browser client takes to open every session's private metadata, every session update and every permission request — called `Buffer.from(...)`, which Vite does not polyfill for the browser build, so the shipped PWA threw `Buffer is not defined` on every decrypt and rendered the mismatched-key state for a perfectly valid AMK. `amk-handoff.ts`, `pairing.ts` and `recovery-escrow.ts` now share the same `btoa`/`atob` codec, and `browser-safety.test.ts` forbids `Buffer` the way it already forbids `node:crypto`. Wire encoding is unchanged and pinned byte-for-byte against Node's own encoder.
- Updated dependencies [c0d6291]
- Updated dependencies [c86aa72]
- Updated dependencies [8f305d0]
- Updated dependencies [fcb76fc]
  - @loombox/protocol@0.1.0
