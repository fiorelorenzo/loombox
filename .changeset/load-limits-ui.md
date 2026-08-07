---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Load and concurrency-limits UI (SPEC §7.16; issue #255)

Surfaces what the node already knows about its own load and per-target concurrency, and makes a queued session's wait explicable rather than indistinguishable from "slow".

- `@loombox/protocol`'s `targetDescriptor`/`targetListEntry` gain optional `maxConcurrentSessions`/`maxConcurrentSessionsSource` (`'configured' | 'default'`) — additive, exactly like `loadPercent`/`hostname` before them: an older node/relay simply omits them.
- `@loombox/node` computes and forwards both fields in `target_announce`, straight off `SessionConcurrencyGate.maxFor` and whether the operator actually set `LOOMBOX_LOCAL_MAX_CONCURRENT_SESSIONS`/`localMaxConcurrentSessions` (or, for an `ssh:` target, its own `SshTargetConfig.maxConcurrentSessions`) versus the node's own computed default.
- `@loombox/relay` forwards the same two fields verbatim from a node's announce into `target_list`'s `TargetListEntry`, exactly like `providers`.
- `@loombox/web`: a queued session's row badge now reads its own wait context ("Queued: waiting for a slot", or "Queued: position N of M waiting for a slot" when more than one session is queued on the same target) instead of a bare "Queued" indistinguishable from "starting slowly" — computed client-side (`target-concurrency.ts`) from data already on the wire (each session's `nodeId`/`targetId`/live status/its transition timestamp, via the new `RelayClient.statusUpdatedAtFor`), no new wire message needed for the position itself. Settings > Nodes (`TargetStatusView.svelte`) now shows each target's `running/cap` slot count, the cap's honest source, and a queued-count badge when nonzero, right next to the existing load/RAM/disk readings.

Verified: `pnpm --filter @loombox/protocol build` (typecheck), `pnpm --filter @loombox/node exec vitest run src/node-daemon-target-concurrency-announce.test.ts src/session-concurrency-gate.test.ts src/node-daemon-target-providers.test.ts` (18 tests), `pnpm --filter @loombox/web exec vitest run src/lib/target-concurrency.test.ts src/lib/components/TargetStatusView.test.ts src/lib/components/pages/SettingsPage.test.ts src/routes/page.test.ts` (163 tests), `pnpm --filter @loombox/web exec playwright test tests-e2e/target-concurrency-mobile.spec.ts` (2 tests, real relay/node/browser, 390px viewport), full `pnpm test` (5365 passed, 2 skipped, 442 files), `pnpm --filter @loombox/{node,relay,web} typecheck`, `pnpm exec eslint` on every changed file, full `pnpm format:check`.
