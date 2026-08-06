---
'@loombox/protocol': patch
'@loombox/providers-core': patch
'@loombox/node': patch
'@loombox/web': patch
---

A session whose agent never started, or failed to start, no longer renders as "Awaiting you" in the sidebar/inbox, and a spawn failure/timeout now reaches the client as a readable error instead of only a node-side `console.warn` (issue #730).

- `@loombox/protocol`: `sessionStatusEventV1` gains an optional `reason`, set only alongside `'error'`.
- `@loombox/providers-core`: `TranscriptState`/`AcpSessionStatusEvent` carry that `reason` through as `statusReason`; `reduceSessionEvent` threads it.
- `@loombox/node`: `sendSessionStatus` takes an optional `reason`, passed through on every spawn failure (`launchLocalSession`'s catch). `ssh:` sessions (`launchReservedSshSession`) now report `'starting'`/`'error'` too — parity with `local`'s issue #516 handling, which they never had.
- `@loombox/web`: `RelayClient.ensureSubscribed`'s first-ever subscribe for a session now retries `session_resume` until the relay's own `session_announce` acks it (new `sessionResumeRetryMs` option), then backfills anything already buffered with one `resync_request(sinceSeq: 0)` — closing the announce-vs-subscribe race a freshly created session lands in (`RelayClient.createSession`'s own doc comment named this issue's "remaining half"). New `RelayClient.statusReasonFor`. The composer, the sidebar/selvage rows, and the transcript pane now gate on every "no live agent" `SessionStatusV1` (`queued`/`starting`/`error`/`exited`/`disconnected`), not just `'disconnected'` (#702's prior scope), and show the reason where the node sent one.

Does not fix #729 (the client still never resyncs on an ordinary reconnect for an already-open session) — this PR's resync is scoped to a session's first-ever subscribe, where duplication is provably impossible, not the general reconnect case.
