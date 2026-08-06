---
'@loombox/providers-core': patch
'@loombox/web': patch
---

The client now resyncs on reconnect, not only on a session's first-ever subscribe (issue #729): a dropped socket, a laptop sleep, or a page reload all recover whatever the relay buffered while disconnected, instead of losing it silently.

- `@loombox/providers-core`: `TranscriptItem` gains a `gap` variant (`TranscriptGapItem`) and a new `reduceResyncGap` reducer — a relay `resync_marker` (`dropped: true`) becomes a visible, idempotent-by-range gap row in the transcript instead of a silent skip.
- `@loombox/web`: `RelayClient` tracks the highest `session_update.seq` applied per session and sends `resync_request(sinceSeq: <that seq>)` on every successful `session_resume` ack — first subscribe (`sinceSeq: 0`, #772's existing path, unchanged) and every reconnect alike, guarded to once per (session, connection) so a first-subscribe's own retry storm doesn't fire it repeatedly. A live delivery and a resync replay of the identical `seq` are deduped so the item is applied exactly once; per-session `session_update` application is now strictly ordered by receipt (not decrypt-completion order), so an older status/config replay can never regress a newer one already applied. `resync_marker` renders via a new `TranscriptGap` row in `TranscriptTimeline`.
