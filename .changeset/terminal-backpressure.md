---
'@loombox/protocol': minor
'@loombox/relay': minor
'@loombox/node': patch
'@loombox/web': patch
---

Applied SPEC §7.16's bounded-queue backpressure rule (drop-oldest plus a resync marker on overflow) to the terminal output stream (issue #207). `terminal_output` used to fan out through the relay's unbounded `fanOutDirect` path, the same as a one-shot control reply; a phone on cellular could never actually block the pipe, but there was also nothing stopping the relay's own socket write buffer from growing without bound behind a genuinely slow client.

- `@loombox/protocol`: `terminal_output` gains a node-assigned, per-terminal `seq` (monotonic from 0). New `terminal_resync_marker` wire message — the terminal-scoped sibling of `resync_marker`, `sessionId` + `terminalId` + `fromSeq`/`toSeq`, no envelope, no replay half (a dropped PTY chunk was never persisted anywhere to replay from, unlike `session_update`'s ring buffer).
- `@loombox/relay`: new `BoundedTerminalOutbox` (`terminal-outbox.ts`). Every open terminal gets its own bounded, drop-oldest queue per client connection (`terminalOutboxFor`, keyed `sessionId:terminalId`) rather than one shared per-connection queue — a real two-terminal test proved a busy terminal's firehose could otherwise evict, and so starve, a second idle terminal's own reply for as long as it kept overflowing. New `maxTerminalQueueDepth` relay option (default 500, floor pacing near-instant rather than the 2ms/item default inherited from `session_update`'s queue) — a real PTY burst at the old defaults (64 depth, 2ms floor) genuinely lost data for an ordinary fast client, not just a slow one; a build log or `find /` would have shown visible gaps under everyday use. `terminal_opened`/`terminal_closed` stay on the unbounded direct path (low-volume, one-shot control replies).
- `@loombox/node`: `terminal_output`'s `seq` is assigned synchronously at the PTY's own `onData` callback, before the async encrypt/send pipeline — independent of whatever order the crypto pipeline happens to resolve in.
- `@loombox/web`: `RelayClient.handleTerminalOutput` now chains through a per-terminal ordering queue (mirrors the existing `session_update` fix for issue #729) — concurrent `crypto.subtle.decrypt` calls have no ordering guarantee of their own, and a burst could previously apply a later chunk to xterm.js before an earlier one finished decrypting. New `RelayClient.onTerminalResync` / `TerminalClient.onTerminalResync`; `InteractiveTerminal.svelte` renders a visible dimmed gap banner in the pane instead of silently missing bytes when a resync marker arrives.

Verified against a real PTY (`bash --noprofile --norc`) through a real relay: a 4000-line burst arrives complete, in order, with zero resync markers at the new default depth; a `terminal_resize` sent mid-burst is applied to the real PTY (proved via `stty size`, not xterm.js/CSS) with the burst surviving intact; a second terminal opened while the first is mid-burst stays responsive.
