---
'@loombox/protocol': minor
'@loombox/relay': minor
'@loombox/node': minor
'@loombox/web': minor
---

AI-assisted merge-conflict resolution (SPEC §7.6; issue #237): when a session's own worktree merge stops on real conflicts, the session's live agent can now propose a resolution for a conflicted file, one agent turn per conflicted hunk, reusing #236's diff-explain shape.

A proposal is always reviewable before anything is written: `git_conflict_resolve_request`/`_response` is read-only, carrying the raw conflict hunks, the agent's per-hunk resolution, and a derived (never self-reported) `origin` — `'ours'`/`'theirs'` only when the agent's reply is an exact match to that real side, `'rewritten'` otherwise, so it's always obvious whether a decision silently picked a side. Applying is one deliberate action reusing #205's own conflict-safe `fs_write_request` with the proposal's `baseHash` — never a bespoke apply message — so a file edited elsewhere between the proposal and the click comes back `'conflict'` rather than being clobbered, and declining is simply never calling it. A file with more conflicted hunks than a 12-hunk bound refuses outright (`'too_large'`) rather than spending an unbounded number of agent turns from one click.
