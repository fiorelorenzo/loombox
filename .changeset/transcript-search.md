---
'@loombox/web': minor
---

Client-side in-transcript search (SPEC §7.19; issues #262/#263)

`Mod+F` (or the "Search transcript" command palette entry) opens a search bar over the open session's transcript. Search runs entirely client-side against the reducer's own `TranscriptState.items` array (`$lib/transcript/search.ts`), never against the DOM — the windowed transcript renderer (issue #755) only ever mounts a scrollable slice of that array, so a naive DOM/native-find scan would silently miss any match outside it. A match found this way is navigated to with the same `TranscriptJumpTarget` mechanism issue #740 shipped for "jump to this file's diff": the target row is forced into the mounted window and scrolled into view, then highlighted using the CSS Custom Highlight API (`$lib/transcript/search-highlight.ts`), never manual DOM text-node wrapping.

Search covers message text (including agent thoughts, regardless of their current collapse state) and tool-call titles/diff file paths; it deliberately never indexes a tool call's raw input, content, or diff body text — see `search.ts`'s own doc comment for the full, explicit field list. A linear scan measured well under 10ms even at 100,000 transcript items in this repo's own dev container.

This ships the search mechanism common to issues #262 and #263; it does not add the multi-project archive of past/ended sessions #262 also describes (listing sessions with a cost rollup, browsing one read-only) — see the PR description for the scope decision.
