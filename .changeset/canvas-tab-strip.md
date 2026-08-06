---
'@loombox/protocol': patch
'@loombox/relay': patch
'@loombox/node': patch
'@loombox/web': patch
---

A tab strip above the canvas for opened files and diffs, transcript pinned leftmost and non-closable (issue #737, settled pick B2-2)

Today the canvas showed exactly one session and nothing else, and the file tree could only insert an `@`-mention — there was no way to actually see a file's content outside whatever diff card the agent's own edit produced. This ships a read-only file viewer plus the tab strip around it:

- `@loombox/protocol`: a new `fs_read_request`/`fs_read_response` wire pair (`fs.ts`), mirroring the existing `fs_list_request`/`fs_list_response` pattern exactly — session-scoped, sealed under the session key, routed to the owning node by `sessionId` alone, fanned back out to every subscribed client. One-shot per open/retry, deliberately not a live subscription (C5-1: the Files panel — and, by the same reasoning, this viewer — stays a browsing tool, not a live view of the agent).
- `@loombox/relay`: routes `fs_read_request` to the owning node and fans `fs_read_response` out to subscribers, grouped with the existing `fs_list_request`/`fs_list_response` cases.
- `@loombox/node`: `NodeDaemon` answers `fs_read_request` via the session's existing `ExecutionTarget.readFile`, reusing `fs_list`'s own path-traversal guard. A 1MB cap truncates (reported via `truncated: true`, never silently); a `\u0000` byte anywhere in the decoded text is treated as binary and refused with a real error rather than forwarding garbled bytes.
- `@loombox/web`:
  - `RelayClient.readFile(sessionId, path)`: a one-shot promise, same "resolves either way, rejects only when unusable" contract as `decommissionTarget`.
  - `$lib/tabs.svelte.ts`'s `CanvasTabsState`: the transcript tab is permanent, pinned first, and structurally never closable/reorderable. Opening the same path from any entry point (the Files panel tree, an `@`-mention pill, a diff card's own new "Open" affordance on `DiffViewer`) activates the same tab rather than duplicating it. The dirty indicator compares each tab's own transcript-position watermark against completed edit tool calls, not a wall clock, so "since you last looked" is exact.
  - `$lib/file-viewer.ts` + `FileViewer.svelte`: reuses `$lib/diff.ts`'s `languageForPath` and `$lib/markdown.ts`'s existing lazy-loaded `renderMarkdownToHtml`/`highlightMarkdownToHtml` pipeline (the file's content is wrapped in a fenced code block CommonMark can never parse as closing early) — no second syntax highlighter.
  - `CanvasTabStrip.svelte`: below `TABLET_VIEWPORT_BREAKPOINT_PX` (768px) the horizontal strip becomes a single active-tab-plus-picker (a `Dialog`-backed list of every open tab), the decisions doc's own named narrow-viewport option, covered by a spec at 390px.
  - Editing stays out of scope — #205 is that work.
