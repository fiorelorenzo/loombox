# Deploying the v0 relay over Tailscale

This is the disposable v0 relay: in-memory only, no TLS, no Postgres/Redis, no
auth (SPEC §12 v0, "Transport-only over Tailscale"). It proves the transport
shape before any Caddy/Let's Encrypt/prodbox work exists (that is v1, SPEC §9).

## Run it

```bash
# Binds to this host's Tailscale IPv4 by default (reachable from the tailnet,
# not the public internet). Override with HOST / PORT.
scripts/run-relay.sh

# or directly:
HOST=100.87.202.117 PORT=8787 pnpm --filter @loombox/relay start
```

The relay serves a single WebSocket endpoint at `ws://<host>:<port>/ws`. Both
the node and the PWA client connect there and identify themselves with their
first frame (`node_hello` / `client_hello`).

To keep it up across reboots, install the example systemd unit
(`scripts/loombox-relay.service`, adjust `HOST`/`WorkingDirectory`/`User`):

```bash
cp scripts/loombox-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now loombox-relay
```

## Confirm reachability

Before the PWA exists, confirm connectivity with a plain WebSocket client. With
the relay bound to the dev box's tailnet IP (`tailscale ip -4` =>
`100.87.202.117`), a node + a client on the tailnet exchange registration and a
session announce:

```
$ HOST=100.87.202.117 PORT=8787 scripts/run-relay.sh
loombox relay -> ws://100.87.202.117:8787/ws
Server listening at http://100.87.202.117:8787
loombox relay listening on ws://100.87.202.117:8787/ws

# from a WebSocket client on the tailnet (here, a throwaway node script):
client received: [
  {"type":"session_list","protocolVersion":0,"sessions":[]},
  {"type":"session_announce","protocolVersion":0,"session":{"id":"s1",...}}
]
RESULT reachable=true session_list=true session_announce_fanout=true
```

That was verified on the dev box against its own Tailscale IP, which exercises
the same tailnet interface a phone would use. A quick manual check with
`websocat`:

```bash
websocat ws://100.87.202.117:8787/ws
{"type":"client_hello","protocolVersion":0,"clientId":"manual-check"}
# -> the relay replies with a {"type":"session_list",...} snapshot
```

## The one human step

The v0 acceptance (SPEC §12) is "from a phone on the tailnet, observe a running
session and inject one prompt." Loading `ws://<tailnet-ip>:8787/ws` from an
actual phone joined to the tailnet is the human confirmation; everything up to
and including the full loop is exercised headlessly by the v0 end-to-end harness
(see the harness under `scripts/`).
