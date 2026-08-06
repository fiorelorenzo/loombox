---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': patch
'@loombox/supervisor': minor
---

Turn-indexed session rewind (design spec `2026-08-05-zed-parity-decisions.md`'s C6-3; issue #747), built on top of #603/#805's `GitCheckpointStore` wiring: the same session, its transcript and its worktree, roll back together — destructive, and confirmed before it runs.

Two new v1 wire messages, `session_rewind_preview`/`session_rewind`, distinct from `checkpoint_*`: `turn` is a plain, node-resolved integer (the same counter #805 already stamps into its `auto: before turn <n>` checkpoint labels), not the ACP-level `turnId` string. `@loombox/node`'s `session-rewind.ts` builds the turn→checkpoint index #805 deliberately left unbuilt, by reading that label back — no separate persisted structure to keep in sync, since the checkpoints' own hidden refs already are the persistence. Rewinding to `turn: N` restores the checkpoint taken before turn `N + 1` (keeping turn `N`'s own effects, discarding everything after) and truncates the session's transcript to match, in the same operation, so the thread and the worktree can never disagree.

`session_rewind`'s confirmation gate reuses #805's own `confirmation_required` mechanism rather than inventing a second one — every valid rewind target discards at least one turn, so an unconfirmed rewind always answers `confirmation_required` with a preview naming exactly what's at risk: `filesAtRisk` (new `@loombox/supervisor` method `GitCheckpointStore.filesAffectedByRestore()`, a file-level diff between the worktree's current state and the target checkpoint) and `turnsAtRisk`. `isWorkInPlace` (#805's own flag) is carried through unchanged, so a client can render the sharper warning an in-place session's uncommitted state deserves. An `ssh:` session gets `errorType: 'unsupported_target'`, same as `checkpoint_*`; a session with no live agent (disconnected since a node restart) gets a new `errorType: 'no_live_agent'`, since truncating a transcript needs the live `AgentSession` object holding it — reviving one on demand is issue #706's own scope, not this one.

`@loombox/supervisor`'s `TranscriptStore` gains `truncateTranscriptUpdates()` (the one place its append-only log design is deliberately broken, since rewind is the one operation that needs it to shrink) and `AgentSession` gains its own `truncateTranscriptUpdates()`, the mirror image of the fork-seeding `seedTranscriptUpdates()` already shipped for issue #746.
