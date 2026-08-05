---
'@loombox/crypto': patch
'@loombox/protocol': patch
'@loombox/relay': patch
'@loombox/node': patch
'@loombox/web': patch
---

Tracker records are addressed by project, not by session, so a project's tracker
is readable when no agent session is running for it. Adds a project resource key
to the AMK key tree (`['project', accountId, projectPath]`), re-addresses the
four tracker record messages to `nodeId` + `projectPath`, and makes the node
answer every request it receives rather than dropping unanswerable ones.
