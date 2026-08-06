---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': patch
'@loombox/supervisor': patch
'@loombox/web': minor
---

Fork a session from any turn into a new one (issue #746, Zed-parity decision C6-2). The transcript up to that turn is copied into a brand-new session with its own worktree, seeded from the source's branch tip plus an overlay of the source's uncommitted and untracked files, so the fork's files match the transcript it starts from. The original session and its worktree are untouched: nothing here reverts anything, which stays C6-3's job and depends on #603.
