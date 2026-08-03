---
'@loombox/web': patch
---

Give the Files and Terminal panels a bounded wait and a real failure state

Both panels sat on an indefinite spinner when a node stopped answering. The
Files panel's loading branch (`FileTreePanel.svelte`) had no failure path at
all, and the terminal (`InteractiveTerminal.svelte`) initialised
`status = 'opening'` and only ever left it once the PTY handshake completed. A
node that had died looked exactly like one that was briefly slow, forever.
The v6 audit hit both with a fake node that never answers: the panels just
said "Loading…" and "Connecting…" and stayed there.

Both now bound the wait to 10 seconds, matching every other request-shaped
`RelayClient` default. A directory or a terminal still waiting when its own
timer fires gets a retryable `ErrorNotice`, worded to match what the shell
already says elsewhere: "the node may be asleep, offline, or on an older
relay" is `DirectoryPicker`'s exact phrasing from issue #505, not a third
convention. For the terminal the wording is deliberately careful, since a
timeout there does not mean the PTY open failed, only that this client
stopped waiting: "this isn't necessarily a failure, we simply stopped
waiting". A late real answer, however long after the deadline, still lands
and clears the failure state, and a directory or terminal that resolves
just under the deadline never shows an error at all.

Retry re-requests rather than only dismissing the notice. The Files panel
calls `onExpand` again, the same lever `expandDirectory`'s own doc comment
already describes for retrying a directory that came back `'error'`. The
terminal asks the node to close whichever attempt just timed out and opens
a genuinely new one, since `RelayClient.openTerminal` treats every call as
an additional terminal with its own id; the keystroke/output/resize wiring
now reads the current terminal id at send time instead of one captured at
mount, so it follows a retry rather than staying pinned to the stale one.

Covered by fake-timer unit tests in `FileTreePanel.test.ts` and
`InteractiveTerminal.test.ts`: a silent node reaching the failure state
within the deadline, a slow-but-alive node answering just under it never
tripping the error, and retry actually re-requesting rather than just
clearing the flag.
