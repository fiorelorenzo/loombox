---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Per-project and per-session spend caps with auto-pause (SPEC §7.16; issue #251)

A session's cumulative cost (the same rollup §7.9's usage meter shows, subagent cost included) can now be capped, and crossing the cap auto-pauses the session rather than letting it run unbounded:

- Two independent scopes: a project-wide cap (`@loombox/node`'s new `SpendCapStore`, one JSON file per node, mirroring `PermissionPolicyStore`'s shape) and a session-scoped cap (`SessionManager`'s new `Session.spendCapUsd` field, persisted through the existing `SessionStore`). The session's own cap wins when both are set — `NodeDaemon.effectiveSpendCapUsd` is the one place that resolution happens.
- `NodeDaemon` accumulates each session's cumulative cost from every `usage_update.costUsd` it forwards (a running max, mirroring `@loombox/providers-core`'s `reduceUsage`) and never treats "this agent has never reported a cost" as `$0` real spend — a cap simply cannot fire until a real cost figure exists, no matter how low it's set.
- Crossing the cap pauses the session (`SessionManager.pauseSession` — the agent process is untouched, exactly per its own "independent of the supervisor's own process-level concerns" design) and pushes a new `'paused'` `session_status` (protocol enum widening, same category as `'queued'`/`'starting'`/`'disconnected'`) carrying a `reason` in the same field issue #730 added for a spawn failure.
- A cap crossed mid-turn (the agent still `'working'`/`'permission_required'`) is deliberately let finish rather than interrupted — there is no ACP-level turn-interrupt wire message yet (`RelayClient.interruptTurn`'s own doc comment says so directly), and the issue's own acceptance line rules out "silently killed." The pause lands the instant the turn actually settles; the UI never claims `'paused'` early.
- Resuming is always a deliberate client act, never automatic: `session_spend_cap_resume` (explicit "continue anyway," envelope-less like `run_cancel`) or a `spend_cap_set` that raises the effective cap back above current spend (auto-resumes as a side effect of that one act). Either path advances a watermark so the same cap doesn't immediately re-fire for spend that never actually changed — it re-arms only once NEW spend grows past it.
- New wire messages: `spend_cap_get`/`spend_cap_set`/`spend_cap_result` (mirrors `permission_policy_get`/`_set`/`_result`'s shape exactly) and `session_spend_cap_resume`, routed by the relay to the owning node without ever seeing a project's or session's actual dollar figure.
- `apps/web`'s `session-status.ts` (the one place a session status becomes words, read by both the status bar and every session row) now renders `'paused'` distinctly — its own tone plus the always-populated `reason`, so a cap pause never reads like a generic failure or another kind of pause.

Not in this change (left for a follow-up issue, since the enforcement mechanism above is complete and independently testable over the wire): a settings panel to set caps from the UI, a "Resume" button, and cross-project attention-inbox/push-notification wiring for a paused session. The protocol/node layer is the full, real implementation; the client surface today is read-only (a paused session's status and reason are visible everywhere `SessionStatusV1` already renders) plus the wire API (`spend_cap_get`/`_set`, `session_spend_cap_resume`) any future panel calls directly.

Verified: `pnpm --filter @loombox/protocol exec vitest run` (594 tests), `pnpm --filter @loombox/node exec vitest run src/node-daemon-spend-cap.test.ts src/spend-cap-store.test.ts src/session-manager.test.ts` (76 tests), `pnpm --filter @loombox/relay exec vitest run src/relay.test.ts` (121 tests), `pnpm --filter @loombox/web exec vitest run src/lib/components/StatusBar.test.ts src/routes/page.test.ts` (109 tests), `pnpm -r typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.
