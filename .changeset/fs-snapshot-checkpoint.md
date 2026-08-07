---
'@loombox/supervisor': minor
'@loombox/node': minor
'@loombox/protocol': patch
---

Filesystem-snapshot checkpoint & rollback for non-git projects (SPEC §7.20/§6; issue #267)

A project that isn't a git repository previously had no checkpoint/rollback at all — exactly the case where an agent doing something destructive is least recoverable. This adds `@loombox/supervisor`'s `FsSnapshotCheckpointStore`: a content-hash checkpoint engine with the identical public surface as `GitCheckpointStore` (`checkpoint`/`listCheckpoints`/`previewRestore`/`restore`/`deleteCheckpoint`/`deleteAllCheckpoints`/`filesAffectedByRestore`, same return shapes), so a caller never needs to know which engine it's holding.

- `checkpoint()` walks the whole working set (no ignore rules exist for a plain folder) and refuses outright, before hashing anything, once the tree crosses 20,000 files or 250 MB (`MAX_FS_SNAPSHOT_FILES`/`MAX_FS_SNAPSHOT_BYTES`) — a cheap stat-only pass, so a refusal never pays for hashing content about to be discarded. `restore()`/`previewRestore()`/`filesAffectedByRestore()` are never capped: a working set that outgrew the cap since its own last checkpoint must stay rollback-able.
- Content is deduplicated by sha256 into a per-session content-addressed blob store outside the project folder; `hashFile` streams file content rather than buffering whole files into memory.
- `@loombox/node`'s `NodeDaemon.getCheckpointStore` now picks the right engine per session: an isolated-worktree session is always git (no probe needed — `SessionManager` only ever forks a worktree off a real repo), a `workInPlace` session probes once via the new `isGitWorktree()` export (extracted from `GitCheckpointStore`'s own probe). Every checkpoint wire handler and the client dialogs above them stay unaware which engine answered — no new wire messages, no new client-facing branching.
- `@loombox/protocol`'s `checkpoint.ts` gains one new named `CheckpointErrorTypeV1` member, `snapshot_too_large`, mirroring the new `SnapshotTooLargeError` the same way the existing git-specific reasons mirror `GitCheckpointStore`'s error classes. Additive only.

Verified: `pnpm --filter @loombox/supervisor exec vitest run` (9 files, 90 tests), `pnpm --filter @loombox/node exec vitest run` (170 files, 1851 tests, 1 skipped), `pnpm --filter @loombox/protocol exec vitest run src/v1/checkpoint.test.ts` (19 tests), all green. Full `pnpm test` run (required — touches `packages/protocol`). `typecheck` on `supervisor`/`node`/`protocol`, `eslint` on every changed file, and `format:check` all clean.
