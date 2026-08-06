---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/web': minor
---

Topbar shows `project / branch`, and the session's target chip moves down into the status bar's left zone (Zed-parity decision B3-3, issue #738).

- `@loombox/protocol`: `SessionPrivateMetaV1` gains an optional, node-computed `branch` field. A client never sends it — only `@loombox/node`'s own `announce()` sets it.
- `@loombox/node`: a new `resolveSessionBranch` helper resolves the branch a session's own state should report. A worktree-isolated session already knows its own `loombox/session-<id>` branch, no git call needed; an in-place session gets a fresh `git branch --show-current` probe against its project folder on every `announce()` (session creation, a fork, and every reconnect's re-announce) — a detached `HEAD` resolves to `detached@<short-sha>` rather than a blank value, and a plain, non-git folder (SPEC §6) resolves `undefined`, not an error.
- `@loombox/web`: the topbar's `.topbar-breadcrumb` now reads `project / branch` instead of `project · target`, omitting the branch segment entirely when the node has nothing to report. `StatusBar`'s left zone gains a `selectedSessionTargetLabel` segment (`status-bar-session-target`) carrying the target the old breadcrumb used to show — the target still appears exactly once in the window, just one level down.

This does not live-update an in-place session's branch the instant it changes on disk while the connection stays open — that would need either polling every open session's git directory or a filesystem watcher, neither of which this codebase uses elsewhere, and a person switching branches under a running session is a rare, deliberate action they already know about. It does refresh at every `announce()` (so a reconnect always shows the true current branch) and on a full reload.
