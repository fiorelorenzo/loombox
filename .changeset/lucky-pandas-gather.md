---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/web': minor
---

Survive a node restart, bound the agent spawn, and make the surface coherent

A node restart no longer forgets every session it owns, so rows stop pointing at sessions nobody tracks and worktrees stop leaking. The agent spawn is bounded, and a session is announced as soon as its worktree exists rather than only once the agent is up.

The node status numbers were wrong: CPU was a load average mislabelled as utilisation, and RAM counted reclaimable page cache as used. Both fixed, and the reading now carries the machine's hostname, platform and arch so a target called "Local" says which machine it is.

On the client: one page title instead of two, one Settings entry instead of three, a real form language instead of eight copies of the same hand-rolled input, dense node rows instead of three progress bars, and a transcript that states who is speaking with a composer that is part of it rather than a chat box bolted underneath.
