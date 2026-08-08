---
'@loombox/protocol': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Closes issue #933, the relay-side half of #929 I deliberately left open in that PR: two connections claiming the same nodeId on the same relay used to resolve with a plain `Map.set()`, whichever announced last silently took over routing, with no check and no signal to either side. That is exactly why #929's own two duplicate `devbox-node-1` processes looked perfectly healthy for 15 hours. #937 already closed the same-machine case with a node-side state-dir lock; this closes the case a lock can never see, when the two connections are not on the same machine.

I picked a rule rather than the first thing that compiled. `relay.ts`'s new `claimNodeRouting` compares `devicePublicKey` (issue #655's build-identity sibling field, an ECDH identity a node's `NodeIdentityStore` persists and reuses across restarts) between the connection that already owns a nodeId and the one that just announced it, since that is the one thing a genuinely different device cannot present:

- Same `devicePublicKey` is an ordinary reconnect: a flaky network dropped a socket and the same physical node came back before the relay's own close/timeout noticed the old one was dead. The new connection takes over exactly like before this fix. The old connection is still told (a new `node_identity_conflict` wire message, then closed 4410), but nothing is logged and nothing is flagged for a client to see, so the common case stays exactly as quiet as it always was.
- A different `devicePublicKey` is a rival: a different device claiming an identity another connection already holds live, the actual #929 failure mode, or a plain misconfiguration. The relay refuses the newcomer rather than the incumbent, on purpose: whatever session an operator is actually driving over the existing connection should not be yanked out from under them by a connection that only just showed up. The rejected connection is told why (`node_identity_conflict`, then closed 4409, mirroring #108's `update_required`/4400 precedent for refusing a peer with a reason), the relay logs a warning naming both connections' accountId/deviceId/remoteAddress, and the surviving connection's `identityConflict` is now mirrored onto every `target_list` row it owns.

The Nodes page (`TargetStatusView.svelte`) renders that as a small "Identity conflict" badge next to a fought-over node's row, with the rival device id and when it happened behind the disclosure, so an operator sees the fight instead of everything looking quietly fine. Reuses the existing `Badge` component and row layout end to end, so it renders the same at 390px as the Behind/Update available badges already sitting next to it.
