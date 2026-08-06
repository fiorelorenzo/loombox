---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Hunk-level git stage/unstage/discard (SPEC §7.6; issue #232)

The working-tree diff tab (issue #206) gains a staging surface: per-file staged/unstaged hunk breakdown, with per-hunk stage, unstage, and discard.

- `@loombox/protocol`'s new `git-hunks.ts` adds the `git_hunk_diff_request`/`git_hunk_diff_response` (read-only, envelope-less, mirrors `git_diff_request`) and `git_hunk_action_request`/`git_hunk_action_response` (enveloped, mutating) message pairs. `@loombox/relay` routes both exactly like their `git_diff_*` siblings — the relay never sees a path, a hunk's content, or which action was taken.
- `@loombox/node`'s `packages/node/src/git-diff.ts` adds `computeHunkDiff` (parses per-file `git diff --cached`/`git diff` output into `GitHunkV1[]`, with a synthetic single hunk for an untracked file) and `applyGitHunkAction` (extracts exactly the addressed hunk into a standalone one-hunk patch and drives it through `git apply --cached`/`--reverse` — the same mechanism `git add -p` itself uses; an untracked file's hunk is special-cased to `git add`/`git clean` since it has no `git diff`-derived patch to extract). Both work identically against a `local` or an `ssh:` target.
- `@loombox/web`: `WorktreeDiffViewer` gets a Diff/Stage changes surface toggle. The staging surface lists each changed file's staged and unstaged hunks (reusing `DiffViewer`'s own `.diff-lines` line rendering), with Stage/Unstage applying immediately and Discard routed through the already-designed `DiscardHunkDialog` confirmation (destructive, unrecoverable — the dialog names exactly what is about to be lost, matching `ArchiveSessionDialog`/`CheckpointRestoreDialog`'s own confirmation pattern). `tabs.svelte.ts`'s `CanvasTabsState` gained a `hunkViewer` field alongside the existing `diffViewer` on the same diff tab (issue #737's tab strip) — not a second tab.

Verified: `pnpm --filter @loombox/node exec vitest run src/git-diff.test.ts src/node-daemon.test.ts` (26 tests against a real temp git repo covering stage/unstage/discard, a multi-hunk file, a partially staged file, deletion hunks, untracked files, and every error path, plus the 4 pre-existing daemon wiring tests), `pnpm --filter @loombox/web exec vitest run src/lib/components/WorktreeDiffViewer.test.ts src/lib/components/DiscardHunkDialog.test.ts src/lib/relay-client.test.ts src/lib/tabs.test.ts` (225+23+10 tests), `pnpm --filter @loombox/{protocol,node,relay,web} typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (4898 tests, 2 pre-existing skips, all green).
