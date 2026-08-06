---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': minor
---

CI check status watcher (SPEC §7.14; issue #239)

For a session whose branch has an open pull request (issue #238's `openPr`), the owning node now polls GitHub's check-runs API and surfaces the result back to the client, plus fires an auto-iterate hook into the agent on a new failure:

- `@loombox/node`'s new `CiCheckWatcher` (`ci-check-watcher.ts`) is `TargetHealthSampler`'s sibling: same fixed-interval (60s), per-session registry, one-pass-at-a-time shape, but polling GitHub's REST API through an injected `resolveToken`/`fetchImpl` instead of an `ExecutionTarget` probe. Its own `FAILING_CONCLUSIONS` judges which of GitHub's check-run conclusions count as a real failure (`failure`/`timed_out`/`action_required`/`cancelled`) — an unrecognized future value is never treated as one. `ci-watch-store.ts` persists which sessions are being watched (one JSON file, mirroring `spend-cap-store.ts`), so a node restart re-registers every still-open PR's watch rather than silently dropping it.
- Exactly-once-per-failure dedup, keyed on the failing state's own `headSha`: the first poll that observes `'failing'` for a commit fires the hook and remembers that sha; every later poll still red on the SAME sha stays silent, and the remembered sha clears the moment a poll stops observing `'failing'` (recovered, or the ref moved to a commit with no check runs yet) — so a later failure, even a re-run landing back on a previously-seen sha, fires again rather than staying suppressed forever.
- `NodeDaemon.registerCiCheckWatch` starts a session's watch right after a successful `pr_open_request` (best-effort — a watch-registration failure never turns an otherwise-successful PR open into a reported failure). `NodeDaemon.resolveCiCheckGithubToken` is the watcher's only source of a bearer token, reusing SPEC §7.26's connected-account pin resolution (`resolveAccountForRead`) exactly like `resolveTrackerBackend`'s own GitHub branch — `github.com` only, and an ambiguous/absent/opted-out pin degrades the watched session to `'unknown'`, never an error.
- New wire message `ci_check_status`: session-scoped and envelope-sealed exactly like `run_output`/`pr_open_result` (the relay only ever sees `sessionId` and ciphertext, never a check's name, conclusion, or failure output), pushed after every completed poll pass, whatever the resulting state.
- The auto-iterate hook (`NodeDaemon.handleCiCheckFailure`) feeds a new failure straight back into the session via `promptSession`, listing every failing check run's name/conclusion/output summary. This is only the hook: driving the resulting turn to a genuinely green re-run (deciding when to stop, re-watching the next poll) is issue #246's job, not this one's.

Verified: `pnpm --filter @loombox/node exec vitest run src/ci-check-watcher.test.ts src/ci-watch-store.test.ts src/node-daemon-ci-check.test.ts` (29 tests, stubbed `fetch`/keyring only, no real network call), `pnpm --filter @loombox/protocol typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/relay typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (4838 tests; one pre-existing, unrelated `apps/web` async-highlighter flake, confirmed passing in isolation).
