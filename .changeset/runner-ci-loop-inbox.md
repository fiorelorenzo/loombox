---
'@loombox/protocol': minor
'@loombox/shared': minor
'@loombox/node': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Local test runner joins the PR/CI loop and the attention inbox (SPEC §7.14/§7.15; issue #247)

The runner (#245), the CI check watcher (#239), the auto-iterate loop (#246), and the inbox's `ci_failure` class (#243) existed as four separate pieces. This wires a local run into the exact same loop and the exact same inbox a remote CI result already uses, so a failing change tells one story regardless of which side observed it first.

- New wire message `run_status` (`@loombox/protocol`'s `run-status.ts`): the node's own durable per-kind (`test`/`lint`/`build`) run outcome for a session, the runner's sibling of `ci_check_status` — node-pushed, session-scoped, envelope-sealed, aggregating to `'unknown'`/`'passing'`/`'failing'`. `@loombox/shared`'s new `isFailingRunOutcome` (a run's outcome is `'fail'`/`'could_not_start'`) is the runner's own `isFailingCiConclusion` sibling, shared between the node and the browser so both name the same runs as failing.
- `@loombox/node`'s new `RunStatusTracker` (`run-status-tracker.ts`) is `NodeDaemon.executeRun`'s own latest-outcome memory, updated from every exit path (a policy denial, an unsafe run id, and a real `run_exit` alike) right alongside the existing `sendRunExit`, and pushed as `run_status`.
- A failing run also drives `CiAutoIterateController` — the SAME controller/session record a CI failure already drives, sharing one attempt count/bound per session rather than two separate loops. The real risk this issue calls out: a CI failure and a local runner failure for the SAME underlying commit must not drive two agent turns. `@loombox/node`'s new `AutoIterateDriveGate` (`auto-iterate-drive-gate.ts`) is the shared cross-source dedup both `NodeDaemon.handleCiCheckFailure` and the new `driveAutoIterateFromRunFailure` consult before ever calling `ciAutoIterateController.onFailure`, keyed on the failing commit's own head sha (`@loombox/node`'s new `workspace-head.ts`'s `resolveWorkspaceHeadSha`, the runner's own `resolveSessionBranch` sibling) — whichever source observes a given sha first drives; the other's own failure for that identical sha still updates its own status/inbox item, it just never fires a second `promptSession` turn. The gate's lifetime is tied to the controller's own active-loop lifetime (cleared alongside `reset()`/`onGreen()`/`forget()`), never CI's own shorter-lived per-poll dedup.
- `@loombox/web`'s `RelayClient.attentionInbox()` gets a new `'run_failure'` class — the exact sibling of `'ci_failure'` (same base `AttentionInboxItem` shape: `sessionId`/`sessionTitle`/`projectPath`/`nodeId`/`waitingSince`, plus its own `failingRuns` alongside `ci_failure`'s `failingChecks`/`prUrl`/`prNumber`), built from `run_status` the same "durable until it clears, never a second guess" way `ci_failure` is built from `ci_check_status`. Independent of `ci_failure`, `awaiting_input`, and `session_outcome`: a session can carry any combination at once. `AttentionInbox.svelte` renders it with its own `'Run'` badge.

Verified:

- `pnpm --filter @loombox/node exec vitest run src/workspace-head.test.ts src/auto-iterate-drive-gate.test.ts src/run-status-tracker.test.ts src/node-daemon-run-ci-loop.test.ts src/node-daemon-ci-auto-iterate.test.ts src/node-daemon-ci-check.test.ts src/node-daemon-test-runner.test.ts src/test-runner-process.test.ts src/test-runner-config-store.test.ts` (250 tests, real local `sh -c`/git subprocesses only, no real network)
- `pnpm --filter @loombox/shared exec vitest run src/run-status.test.ts` (2 tests)
- `pnpm exec vitest run apps/web/src/lib/relay-client.test.ts apps/web/src/lib/components/AttentionInbox.test.ts` (218 + 32 tests, real in-process relay only)
- `pnpm --filter @loombox/protocol typecheck`, `pnpm --filter @loombox/shared typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/relay typecheck`, `pnpm --filter @loombox/web typecheck` — all clean
- `pnpm exec eslint` on every changed/new file — no errors
- the full `pnpm format:check` — clean
- the full `pnpm test` (touched `@loombox/protocol`) — 445 files passed, 1 pre-existing unrelated skip, 5379 tests passed, 2 skipped, 0 failures
