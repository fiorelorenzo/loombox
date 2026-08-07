---
'@loombox/protocol': minor
'@loombox/providers-core': minor
'@loombox/node': minor
'@loombox/web': minor
---

Stalled-session diagnostics (SPEC §7.21; issue #271, epic #32)

Pairs with issue #255's load/concurrency-limits UI and issue #269's node/target health view rather than adding a third surface: every input the new diagnosis reads is data one of those two already computes or exposes on the wire (a session's own live status/reason, `target-concurrency.ts`'s queue-position wording, and `+page.svelte`'s existing `classifyTargetHealth` target-reachability classification). No new wire message, protocol union member, or UI panel.

- `@loombox/node`'s new `attention-reason.ts`: `wireAgentSession`'s `'attention'` listener used to drop `AttentionState.detail` (an exit code, a crash message) on the floor for every mid-session `'error'`/`'exited'` transition — issue #730 only ever gave `'error'` a `reason` for the PRE-spawn failure path. Now a mid-session crash/exit carries a real `reason` too (e.g. `"agent process exited (exit code 1)"`), the same field #730/#251 already use.
- `@loombox/protocol`/`@loombox/providers-core`: doc-only widening of `sessionStatusEventV1.reason`/`AcpSessionStatusEvent.reason` to name this new producer — the schema already accepted `reason` alongside any status, so no shape change.
- `@loombox/web`'s new `session-stall-diagnosis.ts`: `diagnoseSessionStall` turns a session's live status, its target's reachability/health, and its concurrency-queue state into one of exactly four causes — `'queued_at_capacity'`, `'agent_unavailable'`, `'target_unreachable'`, or `'unknown'`. "The agent is thinking" vs. "the agent is wedged" has no node-side signal to tell apart (no per-turn heartbeat exists), so that pair — and anything else left over once the real signals are checked — reports honestly as `'unknown'` rather than guessing. `session-status.ts`'s `sessionStatusLabelWithReason` (the one place a status becomes words) now appends a reason for every status a real producer can supply one for, not a fixed three-status whitelist that would need hand-updating for each new producer. `+page.svelte` wires it as the third tier of the existing `sessionStatusReasons.get(id) ?? sessionQueueReasons.get(id)` fallback chain, so a stalled-looking session's row/status-bar label reads e.g. `"Working: target unreachable — last checked 30s ago"` instead of a bare `"Working"` — and the existing session-row "Target status" link (issue #269) is exactly the "for deeper investigation" surface the diagnosis points at, unchanged.

Verified: `pnpm --filter @loombox/node exec vitest run` (142 files, 1561 tests), `pnpm --filter @loombox/protocol typecheck`, `pnpm --filter @loombox/providers-core typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/web typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (protocol touched — 462 files, 5607 tests, all passing).
