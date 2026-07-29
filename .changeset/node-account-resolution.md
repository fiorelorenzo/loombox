---
'@loombox/relay': minor
'@loombox/node': patch
---

Let a resident node resolve its own account from the token it actually holds.

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
