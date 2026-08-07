---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': minor
---

Agent auto-iterate-until-green loop (SPEC §7.14/§7.15; issue #246)

Builds the loop that #239's CI check watcher hook feeds — `NodeDaemon.handleCiCheckFailure` calls `promptSession` once per new failure, but never decided whether it should, or when to stop:

- `@loombox/node`'s new `CiAutoIterateController` (`ci-auto-iterate.ts`) is fully decoupled from `NodeDaemon`, mirroring `CiCheckWatcher`'s own style: `onFailure(sessionId, headSha, eligible)` decides whether a new CI failure actually drives a new agent turn, `onGreen(sessionId)` ends the loop and resets it the moment a poll reports `'passing'`, and `stopByUser(sessionId)` ends it immediately on request. A bounded `maxAttempts` (default 5) and a sticky user stop both refuse every further failure until a green check or a fresh PR watch (`reset()`); an ineligible session (paused, or over its SPEC §7.16 effective spend cap) is refused for THAT failure only, rechecked fresh on the next one.
- `NodeDaemon.handleCiCheckFailure` now consults `isAutoIterateEligible` (session `'running'` and under its effective `SpendCapStore` cap) and the controller's decision before ever calling `promptSession` — never resuming a paused session, never spending past a spend cap. `onUpdate`'s `'passing'` branch feeds `onGreen`; `registerCiCheckWatch` resets the loop for every freshly-watched PR; session archival forgets it.
- New wire pair: `ci_auto_iterate_status` (node-pushed, session-scoped, envelope-sealed — active/attempts/maxAttempts/stoppedReason plus a per-attempt history) pushed on every real decision, and `ci_auto_iterate_stop` (client, envelope-less, mirrors `run_cancel`) routed to the owning node exactly like `run_cancel`.

Verified: `pnpm --filter @loombox/node exec vitest run src/ci-auto-iterate.test.ts src/node-daemon-ci-auto-iterate.test.ts src/node-daemon-ci-check.test.ts src/ci-check-watcher.test.ts src/ci-watch-store.test.ts` (45 tests, stubbed `fetch`/keyring only, no real network), `pnpm --filter @loombox/relay exec vitest run src/message-routing.test.ts` (151 tests), `pnpm --filter @loombox/protocol typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/relay typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (5035 passed, 1 pre-existing unrelated `codex-acp-capabilities.test.ts` failure from the #158/#182 contract mismatch fixed on main by #834 after this branch was cut, 2 skipped).
