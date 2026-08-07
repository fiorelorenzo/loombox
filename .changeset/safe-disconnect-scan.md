---
'@loombox/protocol': minor
'@loombox/relay': minor
'@loombox/node': patch
'@loombox/web': patch
---

Safe-disconnect: scan and warn before removing a pinned account (SPEC §7.26, issue #229)

Disconnecting a `ConnectedAccount` used to carry a generic "any pinned project may stop working" warning with no way to know which projects, or whether there were any. `AccountPinStore` already holds the real per-project, per-capability pin map, so the warning can name real projects instead of guessing.

- `@loombox/protocol`: new `account_pin_scan_request`/`account_pin_scan_response` wire messages — a client asks `nodeId` to scan every project it has ever recorded a pin for and report every `{projectPath, capability}` still pinned to a given account. Sent before `connected_account_disconnect_request`, never as part of it. `connectedAccountDisconnectRequest`'s doc comment now states the decision explicitly: a pin naming the disconnected account is left dangling, not cleared or blocked, so the next resolve through it fails with the existing `AccountPinDanglingError` (an honest, real failure) instead of silently falling back to a different account.
- `@loombox/node`: `AccountPinStore` gains `allProjectPins()` (every project this node has ever recorded a pin for). New pure `scanPinsForAccount` in `account-pin.ts` (I/O-free, sorted output) is `NodeDaemon`'s new `handleAccountPinScanRequest`'s I/O-free core.
- `@loombox/relay`: routes `account_pin_scan_request`/`_response` through the existing shared connect/pin/tracker-mode request table (`pendingAccountRequests`).
- `@loombox/web`: `RelayClient.scanAccountPins`. `ConnectedAccountsList`'s Disconnect button now runs the scan first — an account with no pins disconnects immediately with no extra confirmation step, one with pins shows a confirm bar listing the real `projectPath`/`capability` pairs found and requires an explicit confirm before disconnecting.

Verified: `pnpm --filter @loombox/protocol typecheck`, `pnpm --filter @loombox/relay typecheck`, `pnpm --filter @loombox/relay exec vitest run src/message-routing.test.ts src/account-connect.test.ts src/account-route.test.ts` (209 tests), `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/node exec vitest run src/account-pin.test.ts src/account-pin-store.test.ts src/node-daemon-account-connect.test.ts` (63 tests, including a real `AccountPinStore` fixture with several mixed pins, and a full scan → disconnect → rescan → resolve round trip proving the dangling-pin failure), `pnpm --filter @loombox/web exec svelte-check` (0 errors), `pnpm --filter @loombox/web exec vitest run src/lib/components/ConnectedAccountsList.test.ts src/lib/components/ConnectedAccountsSection.test.ts src/lib/components/pages/SettingsPage.test.ts` (39 tests), `pnpm exec eslint` on every changed file.
