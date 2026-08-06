---
'@loombox/web': patch
---

Remove the Starting prompt field from the New session dialog and everything behind it (issue #761). A session is always created empty now; the first thing said goes through the composer's ordinary follow-up path instead. `CreateSessionOptions` drops its `prompt` field along with the `timeoutMs` field and the poll-until-the-node-announces-it wait `RelayClient.createSession` used to do purely to time that prompt safely — neither has anything left to do once there is no prompt to time, so `createSession` now simply returns the generated session id the moment `session_create` is on the wire. This also removes one trigger for issue #730 (a prompt silently dropped in the window between the node's announce and the agent bridge existing); #730's other half — a session with no agent yet must not render as "Awaiting you" — is unrelated and still open.
