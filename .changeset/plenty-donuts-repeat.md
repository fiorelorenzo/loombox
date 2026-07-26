---
'@loombox/protocol': minor
'@loombox/relay': minor
'@loombox/node': minor
'@loombox/web': minor
---

Survive a relay restart, follow the agent, and let a session be archived.

A relay redeploy used to brick every node until someone restarted it by hand: a
peer built on the WHATWG WebSocket cannot send a transport-level ping, so nodes
and clients now probe liveness with a `ping`/`pong` pair the relay answers and
advertises as a `heartbeat` capability, and both reconnect with backoff from a
single handler wired to close _and_ error.

The transcript now follows the agent's newest output instead of sitting pinned
at the first frame, detaching when you scroll up to read.

Sessions can be archived from the row menu, optionally taking their git
worktree and branch with them, so a project stops accumulating one worktree per
session that nobody would ever prune by hand.
