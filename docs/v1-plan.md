# loombox v1 plan

The locked decisions are in issue **#315** (v1 architecture decisions) and
`AGENTS.md`. This is the build plan for the v1 milestone. v0 is complete (23/23).

## Session-metadata boundary (the relay is a blind router)

The relay is a blind router plus a ciphertext store. Per session it may index
only **non-encrypted routing metadata** (id, nodeId/target, accountId,
timestamps) so the PWA can list "your sessions across all your nodes" without a
QR each time. Everything else, including the **session title and project path**,
and all transcript content, prompts, tool calls, plans, and attachments, is
E2E-enveloped and opaque to the relay.

## Protocol v1 (the contract, one PR)

Native WebSocket, Zod-validated JSON frames, version negotiated once per
connection (initialize handshake). Built as **one focused PR** (#106) with the
compatibility test suite (#109), TDD from commit one, reviewed before B/C/D fan
out. Message families:

- **Handshake + version:** initialize (protocolVersion, Better Auth bearer,
  device id/pubkey) to negotiated capabilities. (#106, #107, #108, #121)
- **Auth + devices:** device registration, AMK escrow (recovery-code blob),
  new-device bootstrap (recovery or QR), revoke/rotate. (#112-#116)
- **Targets + sessions:** target_announce (local + `ssh:`), session
  create/announce/resume/list, per-target concurrency caps. (#65, #66)
- **Session updates:** session_update_envelope = **encrypted** ACP update
  (msg/thought chunks, tool_call/+diff, plan, usage) + per-session `seq` for
  resync; the relay replays ciphertext on reconnect; bounded drop-oldest
  backpressure. (#135, #177, #98, #254)
- **Steering + permissions:** encrypted prompt_inject, FIFO
  permission_request/response, config-option picker (model/mode/effort).
  (#144, #178, #179)
- **Attachments:** encrypted blob upload/download by opaque ref; the ref travels
  in the ACP content block. (#99)
- **Push + presence:** per-device presence, presence-aware VAPID push (suppress
  on active clients).

## Waves

- **A. Protocol v1** (keystone, first, one PR).
- **B. E2E + auth + relay** (parallel): envelope wiring + device pairing (#113) +
  AMK escrow (#114/#115) + device registry (#112); relay v1 (native ws + Postgres
  ciphertext #99 + Better Auth #121 + resync/backpressure #98/#254).
- **C. node v1 + supervisor v1** (parallel): node (target abstraction
  `local`+`ssh:`, encrypt-all, resync, pooled SSH + mise/PATH fix, remote
  deploy-and-detach); supervisor (persistent detached sessions, resume, on-disk
  transcript per §7.22).
- **D. providers-core v1 + client v1** (parallel): core (session lifecycle #176,
  permission FIFO #178, config #179, capabilities #180, registry #181); client
  (decrypt + reducer, session list, full transcript UX: tool cards #139/#140,
  diff #141, plan #143, permission queue #144-#148, config bar #149, attachments,
  push).

Providers: **Claude Code only** in v1; Codex is a v2 fast-follow (#182/#185/#158).

## CI/CD gate

CI (`.github/workflows/ci.yml`) runs the full lint + format + typecheck + test +
license matrix on every push/PR to `main` and is the merge gate; locally run only
the minimal covering subset (see `AGENTS.md` "Local verification"). As v1 adds
services, extend CI (Playwright for the PWA, a relay build), and add **CD** (relay
image build + deploy to prodbox behind Caddy/TLS) together with the relay v1 work.
