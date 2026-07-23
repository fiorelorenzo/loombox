# Deploying a resident loombox node (devbox)

`packages/node` is the orchestrator node daemon (SPEC §5.1, §5.2, §5.6): it
connects outbound to a relay, spawns/owns agent sessions via
`@loombox/supervisor` and a real Claude Code ACP agent, and E2E-encrypts
every session update before it leaves the host. Unlike the relay/web PWA
(both dockerized, see `deploy/relay`/`deploy/web`), the first resident node
runs as a plain systemd service directly on the devbox: it needs a real
`claude` CLI install and a git worktree checkout on the machine actually
running the agent, not a container.

## What it is

- A single long-running process (`packages/node/src/main.ts`, no build/emit
  step - `packages/node/package.json`'s `start` script is `tsx src/main.ts`,
  the same "run TS sources directly" shape `packages/relay/Dockerfile` uses
  for the relay) that dials out to a relay over WebSocket, authenticates as
  a device of your account, and from then on spawns/drives Claude Code ACP
  sessions the web app creates against it.
- No inbound port, no database of its own. Everything it needs to run
  (relay URL, bearer token, Account Master Key) comes from env - see
  `loombox-node.env.example`.

## Prerequisites

- The relay already deployed and reachable (`wss://relay.loombox.dev`, see
  `docs/deploy-relay.md`) and the web app reachable (`deploy/web/README.md`)
  - a node is not useful without either.
- A loombox account (sign in once at `https://app.loombox.dev` via GitHub
  OAuth) with a Recovery Code set (Settings > Recovery Code) - the node
  bootstraps its copy of your account's Account Master Key from this, the
  same crypto path the web app itself uses (issue #386).
- This repo checked out on the host that will run the node, with
  dependencies installed: `pnpm install` at the repo root (a normal
  workspace install, not `--prod` - `tsx` is a devDependency the `start`
  script needs).
- A real `claude` CLI on PATH for the service user, and a non-interactive
  credential for it: `claude setup-token` (not a browser-held `/login`
  session - see the root `CLAUDE.md`'s notes on why the devbox uses a
  static `CLAUDE_CODE_OAUTH_TOKEN`). The node spawns Claude Code as an ACP
  agent via `npx -y @agentclientprotocol/claude-agent-acp`, which wraps that
  `claude` binary (`packages/providers/claude/src/provider.ts`); the first
  invocation also needs network egress to the npm registry to fetch that
  package (`npx` caches it after).

## Bring up

### 1. Get a device token (#387)

A resident node has no browser to hold a session token in, so it's meant to
authenticate via a device-authorization grant, the same shape as
`gh auth login`: the node prints a short code, you approve it once in a
browser at `https://app.loombox.dev/device`, and the node gets back its own
bearer token - never a browser-held token copy-pasted by hand. That's
`resolveAccountId`'s and `LOOMBOX_AUTH_TOKEN`'s intended source
(`packages/node/src/config.ts`), illustratively:

```bash
pnpm --filter @loombox/node exec tsx src/main.ts login
# loombox node: go to https://app.loombox.dev/device and enter code WXYZ-1234
# loombox node: waiting for approval...
# loombox node: approved - token saved
```

**Status:** this is #387, still open as of this deploy - there is no
`login` subcommand or `/device` endpoint in the repo yet, the snippet above
is illustrative of the interface #387 is expected to add, not something you
can run today. Until it lands, get a bearer token by whatever means #387
actually ships (or, as a stopgap, a Better Auth session token copied out of
an authenticated browser's storage - fine for a one-off manual bring-up,
not the intended long-lived path) and set it as `LOOMBOX_AUTH_TOKEN` below.
Check whether #387 has since merged before following this step literally.
The systemd unit and env file here are otherwise ready to go the moment a
token exists, by whichever route it was obtained.

### 2. Configure the env file

```bash
cp deploy/node/loombox-node.env.example /etc/loombox-node.env
sudo chmod 600 /etc/loombox-node.env
sudo chown dev:dev /etc/loombox-node.env
```

Edit `/etc/loombox-node.env` and fill in at least:

- `LOOMBOX_RELAY_URL` - `wss://relay.loombox.dev` (already the default in
  the example file).
- `LOOMBOX_NODE_ID` - a name for this node (e.g. `devbox`).
- `LOOMBOX_AUTH_TOKEN` - the device token from step 1.
- `LOOMBOX_RECOVERY_CODE` - your account's Recovery Code (Settings >
  Recovery Code in the web app), so the node can bootstrap the AMK.
- `CLAUDE_CODE_OAUTH_TOKEN` - from `claude setup-token`, so the spawned
  Claude Code ACP agent can authenticate.

See the comments in `loombox-node.env.example` for every var
`packages/node/src/config.ts`'s `loadNodeConfig` reads (also documented in
that function's own doc comment) and their exact precedence/validation
rules.

### 3. Install the systemd unit

```bash
sudo cp deploy/node/loombox-node.service.example /etc/systemd/system/loombox-node.service
# Adjust User=/WorkingDirectory=/the mise shims path in the unit if your
# checkout or install differ from the devbox defaults it's written for.
sudo systemctl daemon-reload
sudo systemctl enable --now loombox-node.service
```

### 4. Verify

```bash
journalctl -u loombox-node.service -f
# loombox node "devbox": connecting to wss://relay.loombox.dev (targets: local)
# loombox node "devbox": connected
```

Then open the web app, sign in to the same account, and confirm the node
(and its `local` target) shows up as available, and that creating a session
against it actually starts a real Claude Code agent (its first response
should appear in the session view).

## Updating

```bash
cd /home/dev/Progetti/loombox
git pull
pnpm install
sudo systemctl restart loombox-node.service
```

## Notes

- **Restart=always** in the unit means a crashed or killed node comes back
  on its own; a relay disconnect is handled inside the daemon itself
  (reconnect-with-backoff), a full process restart is only for the daemon
  crashing outright.
- The node's own E2E identity keypair persists across restarts at
  `LOOMBOX_NODE_STATE_DIR` (default `~/.loombox/node`, see
  `packages/node/README.md`'s "Secrets at rest" section) - don't delete it
  between restarts, or the node re-registers as a new device.
- Losing `LOOMBOX_RECOVERY_CODE` doesn't lose account access by itself (it's
  re-derivable/re-shown from the web app's own key custody), but treat it
  with the same care as any other credential in this file: the `.env` is
  chmod 600 and never committed.
