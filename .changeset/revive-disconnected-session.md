---
'@loombox/protocol': minor
'@loombox/relay': minor
'@loombox/node': minor
---

Revive a disconnected session's agent on demand (SPEC §7.1 "reconnected"; issue #706, epic #559)

Closes the gap #702 deliberately left open: a session reloaded `'disconnected'` after a node restart used to drop every `prompt_inject` silently (a `console.warn` only this node's own logs ever saw, and no reply channel existed to tell a client otherwise).

- `@loombox/protocol`: new `prompt_inject_result` wire message (`packages/protocol/src/v1/steering.ts`) — the owning node's reply to a `prompt_inject`, `outcome: 'ok' | 'error'` keyed by `promptId`, mirroring `config_option_result`'s own shape/precedent. Added to the `wireMessageV1` union and `schemasV1` registry.
- `@loombox/relay`: routes `prompt_inject_result` node -> relay -> every subscribed client, exactly like `config_option_result` (`message-routing.ts`, `relay.ts`).
- `@loombox/node`:
  - `SessionManager` gains a `revive` transition (`'disconnected'` -> `'running'`), applied only once a revival's spawn has actually succeeded — a failed attempt leaves the record `'disconnected'`, never mislabeled.
  - New `SessionTitleStore` persists a session's display title (`announce()`'s own private-envelope field) across a node restart, so a revival's own re-`announce()` never overwrites the relay's cached title with a placeholder.
  - `NodeDaemon.reviveSessionInternal` spawns a brand-new agent process into the session's still-on-disk worktree/branch (same concurrency governance, SPEC §7.16, as an ordinary creation), coalescing concurrent revive attempts for the same session.
  - `handlePromptInject` now: delivers to a live bridge unchanged; answers a `'paused'` (spend-cap) session with `outcome: 'error'` instead of a silent drop; revives a `'disconnected'` session on demand and delivers the triggering prompt to it, answering `outcome: 'error'` if the revival itself fails; answers any other bridge-less state (`'ended'`) with `outcome: 'error'` too.
  - Deliberately does NOT replay the old transcript into the revived agent's own context — a node restart means the old agent process is genuinely gone (`SessionLifecycleState`'s own `'disconnected'` doc comment), and pretending a fresh `session/new` remembers anything it knew would be exactly the false continuity issues #204/#249 already ruled out. The `'starting'` status this pushes carries an honest `reason` disclosing that the revived agent has no memory of turns before this point; the transcript itself (unaffected — it lives in the relay's own resync ring under the session's id, independent of which agent process is live) is what the user still sees.

**Not included in this changeset:** the web client's own composer/UI wiring for the disconnected-session revive flow (enabling the composer instead of the existing disabled state, surfacing `prompt_inject_result` errors, and the transcript-side "no memory before this point" disclosure at 390px) — see the PR description for exact status.

Verified: `pnpm --filter @loombox/protocol test` (845 tests), `pnpm --filter @loombox/relay test` (589 tests, incl. `message-routing.test.ts`'s exhaustiveness check), `pnpm --filter @loombox/node exec vitest run src/node-daemon.test.ts src/node-daemon-session-revive.test.ts src/node-daemon-spend-cap.test.ts src/session-manager.test.ts` (173 tests), `pnpm --filter @loombox/protocol typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/relay typecheck`, `pnpm exec eslint` on every changed file.
