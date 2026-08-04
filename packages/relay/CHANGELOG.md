# @loombox/relay

## 0.2.0

### Minor Changes

- 5118b26: Add the `ConnectedAccount` data model and its relay metadata sync (SPEC §7.26)

  `@loombox/protocol` gets `v1/connected-accounts.ts`: the provider-agnostic `ConnectedAccount` type, Zod-validated and registered in `schemasV1` field-for-field per spec (`id`, `provider`, `host`, `providerAccountId`, `label`, `avatarUrl`, `credentialSource`, `scopes`, `capabilities`, `connectedAt`, `updatedAt`, `secretRef`). `id` is derived, never free-form: `composeConnectedAccountId`/`parseConnectedAccountId` round-trip `provider:host:providerAccountId`, tolerant of a colon-bearing `host` (a GitHub Enterprise Server or Jira Data Center instance on a non-default port). `providerAccountId` rejects anything shaped like an email address for every provider, and additionally requires a numeric value for `github` (GitHub's own `GET /user` id). There is deliberately no `nodePresence` field: which node holds a given account's secret locally is computed lazily at the point of use (issue #228), never synced.

  `@loombox/relay` wires the metadata row through its existing account-scoped sync path: a `ConnectedAccountStore` (in-memory and Postgres, new `connected_accounts` table), a node-only `connected_account_announce` message, and a client-only `connected_account_list_request`/`connected_account_list` pair, mirroring `target_announce`/`target_list_request` exactly. The synced row never carries a secret: `secretRef` only names a node-local OS-keyring entry (the same class of secret as SSH keys and MCP secrets), and the row is relay-readable plaintext by design, the same "account-scoped metadata" exception SPEC §8 already grants session existence and the device registry.

  No connect flow ships here (GitHub device grant, `gh` CLI import, PAT paste, Jira token, Jira 3LO are issues #222-#226), no management UI (#230), no per-project pinning (#227), no node-presence computation (#228, referenced above).

### Patch Changes

- bca2cd0: `/health` now checks Postgres and Redis before answering

  Previously `/health` was a plain liveness stub: `{"status":"ok"}` on every
  request, regardless of whether the relay's Postgres or Redis was actually
  reachable. It's now a real readiness probe (SPEC §7.21): a `SELECT 1`
  against Postgres and a `PING` against Redis (only when `REDIS_URL` is
  configured), each racing its own short timeout so a hung dependency 503s
  instead of hanging the request. 200 means both configured dependencies are
  reachable; a 503 body names which one failed, e.g.
  `{"status":"unhealthy","failed":["postgres"]}`. Still unauthenticated and
  exempt from the per-IP rate limit — an external uptime checker has no
  session and polls on its own schedule.

  See `docs/deploy-relay.md`'s new "Monitoring" section for pointing an
  external uptime service at this endpoint.

- Updated dependencies [5118b26]
- Updated dependencies [a449b22]
- Updated dependencies [c97a2cf]
  - @loombox/protocol@0.2.0

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
