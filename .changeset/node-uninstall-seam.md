---
"@loombox/node": minor
"@loombox/desktop": minor
"@loombox/web": minor
---

Uninstall on the supervisor-backend seam (issue #814, epic #653; decision E1-3): `uninstallNode()` revokes a node's own device on the relay and tears down its local install through the platform's `SupervisorBackend`, removing the state dir and OS keyring entry by default (`keepData` is the explicit opt-out). `packages/node/src/ssh/decommission.ts` moves onto the same seam instead of hand-rolling its own systemctl/rm sequence, so the unit and its versioned bundle are now genuinely gone by default too. The desktop app's Nodes page gains a real Uninstall action on a local node's own row, behind a confirmation that names what is destroyed (session history and project secrets, unrecoverable from the relay) and a keep-data checkbox.
