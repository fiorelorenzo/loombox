# @loombox/crypto

## 0.1.0

### Minor Changes

- 4cc52b4: A full user keymap, remappable and synced per account (Zed-parity F3-3, issue #760, building on the action registry #758 and default binding set #759).

  Every registered action is remappable from Settings → Keyboard. Storage: a new account-scoped `keymaps` table on the relay (`keymap_get_request`/`keymap_set_request`/`keymap_result`), sealed under `@loombox/crypto`'s new `deriveKeymapKey` (`['keymap', accountId]`, no session or project involved at all — a keymap edit works with zero nodes online). Fetched proactively on every fresh connection, so a remap survives a new device sign-in from first paint; saved live to `RelayClient.keymap`, which `action-registry.ts`'s `effectiveShortcut`/`matchShortcut` now accept as an `overrides` param, so a remap takes effect without a reload everywhere the registry is read — the palette, the keyboard dispatcher, and `CanvasZeroState`.

  The two questions the decision required answering, not glossing over:

  1. **The phone.** The Keyboard settings section never renders on a narrow viewport (`SettingsPage.svelte`, gated on `viewport.ts`'s `isNarrowViewport`) — recording a chord has nothing to attach to with no physical keyboard to press. The resolved bindings still apply globally regardless of viewport (harmless with no keyboard, useful with a paired one).
  2. **Per-device availability.** The keymap stays a single per-account record with no per-device field. `$lib/keymap.ts`'s `isChordUnavailableHere` computes a runtime "unavailable here" state instead, generalizing issue #759's own browser-reserved-chord rule (`Mod+N`, `Mod+Alt+Right`/`Left`) to any user-remapped chord that lands on one of those reservations — a binding reserved on this device still saves and still works on another.

  An invalid or conflicting candidate (unknown action id, malformed chord, two actions sharing a chord) is rejected client-side by `$lib/keymap.ts`'s `validateKeymapCandidate`, naming the offending entry, before it is ever sent — the previously saved keymap is never touched. Two tabs on the same account: last full write wins at the relay, and every other open connection on that account is pushed the winning state live (not just the requester), so a losing tab corrects itself instead of drifting stale.

### Patch Changes

- Updated dependencies [584520e]
- Updated dependencies [a0fb0a6]
- Updated dependencies [0c46b48]
- Updated dependencies [8a3fcda]
- Updated dependencies [97598db]
- Updated dependencies [ff1fb1e]
- Updated dependencies [7ad7274]
- Updated dependencies [79f55e0]
- Updated dependencies [6d3ad95]
- Updated dependencies [6325366]
- Updated dependencies [d03fc5d]
- Updated dependencies [166551b]
- Updated dependencies [757fa0e]
- Updated dependencies [dace883]
- Updated dependencies [89355b1]
- Updated dependencies [109184d]
- Updated dependencies [4cc52b4]
- Updated dependencies [4291dc3]
  - @loombox/protocol@0.7.0

## 0.0.7

### Patch Changes

- Updated dependencies [6f90259]
- Updated dependencies [e6c44d0]
- Updated dependencies [9b5f66a]
  - @loombox/protocol@0.6.0

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
