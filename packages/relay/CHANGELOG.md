# @loombox/relay

## 0.1.0

### Minor Changes

- 10df3db: Let a resident node resolve its own account from the token it actually holds.

  A node that linked itself the intended way, through the device-authorization
  flow (it prints a short code, you approve it in the browser, it persists the
  token it mints), then died on startup with "authToken (LOOMBOX_AUTH_TOKEN) is
  not a valid, active Better Auth session". It was holding a token the relay
  accepted on the WebSocket handshake seconds later: the node asked Better Auth's
  `/api/auth/get-session`, which only knows browser sessions, while a device
  token lives in the relay's own `device_tokens`. The only way through was
  setting `LOOMBOX_ACCOUNT_ID` by hand, which defeats the point of the flow.

  The relay now answers the question itself, via `GET /account`, using the same
  `resolveAccountId` the WS handshake uses, so device tokens, Better Auth
  sessions and the no-Postgres dev stub all resolve identically. The node asks
  that endpoint, and falls back to the old Better Auth lookup only when a relay
  is too old to have the route, since self-hosters upgrade relay and node
  independently.

- 8f305d0: Survive a relay restart, follow the agent, and let a session be archived.

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

### Patch Changes

- a7fe2c6: Pin the target-health fields through the relay's parse-and-forward. Zod strips keys its schema does not know, so a relay build older than the node's silently drops `loadPercent`, `hostname`, `platform` and `arch`, and the client shows an em dash for load and no machine identity at all. A stale production container did exactly that, with nothing anywhere reporting it.
- fcb76fc: Offer the agents a target can actually run, and fix what the forms ask. Nodes now probe each target's own PATH and announce which providers work there, so the agent picker is a real choice instead of a hardcoded one-option dropdown. Adds Codex and Oh My Pi as real providers alongside Claude Code. The new-session dialog leads with the starting prompt, no longer reshapes itself ten seconds after opening, and every form marks the one required field instead of labelling the four optional ones.
- Updated dependencies [c0d6291]
- Updated dependencies [c86aa72]
- Updated dependencies [8f305d0]
- Updated dependencies [fcb76fc]
  - @loombox/protocol@0.1.0
