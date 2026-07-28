---
'@loombox/web': minor
---

Say something true when a new session times out: the node cuts the worktree before the agent is up and only announces afterwards, so a timeout there is not evidence the session failed. The dialog no longer shows the raw wire identifier, and no longer claims it did not happen.
