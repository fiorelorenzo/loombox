---
'@loombox/web': minor
'@loombox/shared': minor
---

Surface failing CI checks in the attention inbox (SPEC §7.13/§7.14; issue #243)

Issue #239's CI check watcher already streams a session's latest check-run state to the client over `ci_check_status`. This wires that state into the cross-project attention inbox as a real, live `'ci_failure'` item, following the exact conventions the inbox already uses for `permission`/`awaiting_input`/`session_outcome`:

- `RelayClient` decrypts `ci_check_status` into a new per-session store and recomputes the inbox whenever it changes, same as the transcript/permission-queue stores already do. A session contributes a `'ci_failure'` item exactly while its latest known state is `'failing'` - independently of its live status, so a session can be idle/finished and have a failing check on its open PR at the same time. The item clears the instant a later poll reports anything else (`'passing'`, `'pending'`, `'unknown'`), so a check going green never leaves a stale item behind, and a flapping check never accumulates duplicates - it is always the one latest reading for that session.
- The item carries what's needed to act on it: the session, the failing check run names (`failingChecks`), and the PR's own URL/number (`prUrl`/`prNumber`) so a renderer can link straight to it.
- New `@loombox/shared` export `isFailingCiConclusion`: the same conservative "which GitHub check-run conclusions count as a failure" judgment the node's own `ci-check-watcher.ts` uses, now also available to the browser so it names the exact same failing check(s) rather than guessing independently.
- `AttentionInbox.svelte` names the failing check(s) in the row body instead of a bare "CI check failed", and adds a "View PR" link for a `'ci_failure'` row. `'review_request'` remains the one still-unwired extension point (needs the tracker integration work, v2).

Verified: `pnpm --filter @loombox/web exec vitest run src/lib/relay-client.test.ts src/lib/components/AttentionInbox.test.ts src/lib/components/pages/InboxPage.test.ts` (196 tests), `pnpm --filter @loombox/shared test` (24 tests), `pnpm --filter @loombox/web typecheck`, `pnpm --filter @loombox/shared typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.
