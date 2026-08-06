---
'@loombox/web': minor
'@loombox/node': minor
'@loombox/relay': minor
'@loombox/protocol': minor
---

Add the working-tree diff viewer (SPEC §7.4, issue #206): a session's actual uncommitted changes (staged + unstaged + untracked, compared against `HEAD`), opened as a real tab in the canvas tab strip (issue #737) rather than a dialog.

- `@loombox/protocol`: new `git_diff_request`/`git_diff_response` wire pair (`packages/protocol/src/v1/git-diff.ts`) — shaped like `fs_read_request`/`fs_read_response` (issue #737), no envelope on the request (asking carries no content, mirroring `checkpoint_list`).
- `@loombox/node`: `packages/node/src/git-diff.ts`'s `computeWorktreeDiff` runs real `git status`/`git show` through `ExecutionTarget.exec` — the same `git -C <worktree> ...` shape issue #238's `pr-open.ts` already established, so this works against a `local` or an `ssh:` target identically. A binary/symlink change collapses to `DiffViewer`'s existing `oldText: null, newText: ''` structural-only shape; a deleted file gets `newText: ''`; a rename carries `previousPath`.
- `@loombox/relay`: routes the new pair exactly like the `checkpoint_*`/`fs_read_*` families — always blind to the envelope's contents.
- `@loombox/web`: `WorktreeDiffViewer.svelte` renders inline (reusing `DiffViewer.svelte` unchanged, per file) and split (reusing `$lib/diff.ts`'s `diffStats`/`computeLineDiff` via the new `pairDiffLinesForSplitView`, laid out in two columns) — no second diff algorithm anywhere. Split degrades to inline below the tablet breakpoint, where two columns have nowhere to go. Opens via a new "Working tree diff" button above the Files panel tree, as `$lib/tabs.svelte.ts`'s new `DiffCanvasTab` tab kind.
