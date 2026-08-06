---
'@loombox/providers-core': patch
'@loombox/protocol': patch
'@loombox/node': patch
'@loombox/supervisor': patch
'@loombox/web': patch
---

Stop dropping `available_commands_update` on the floor, and carry the agent's declared `/`-command catalogue through to a client-side store (issue #741)

`AcpClient.mapToTranscriptUpdate`'s switch had no case for `available_commands_update`, so it fell into `default: return undefined` — a real agent's declared command list (`omp acp`'s own doc comment already said prompting emits it) was silently dropped, exactly the gap `client.ts:409-461`'s own comment flagged. Both #743 (slash commands in the composer) and #754 (MCP prompts as slash commands) need this catalogue, so it is built once here as shared plumbing, with no UI.

Follows the config-option catalogue's own shape end to end, the way the issue asked for, rather than inventing a second one:

- `@loombox/providers-core`: a new `AvailableCommandsStore` (mirrors `ConfigOptionStore` — per-session, wholesale-replaced, `EventEmitter`-backed), fed by `AcpClient.availableCommands` off the real `available_commands_update` notification (`mapAvailableCommands`, same convention as `mapConfigOptions`). `TranscriptState.commands` carries it through `reduceSessionEvent` for the client-side reducer path.
- `@loombox/protocol`: `acpAvailableCommandV1`/`availableCommandsUpdateEventV1`, a sixth `SessionLifecycleEventV1` member riding the existing `session_update` envelope (no new wire message type).
- `@loombox/node`: `NodeDaemon.wireAgentSession` forwards `AgentSession.availableCommands`'s `'changed'` event as `available_commands_update`, same sealing/ordering/`sendQueue` as every other session-lifecycle event. `AgentSession` gained an `availableCommands` getter mirroring `configOptions`.
- `@loombox/relay`: no change. `relay.ts` already forwards `session_update` opaquely without a per-kind switch, so this never needed a new case — checked directly against the drop-silently pattern issue #691 describes, since `available_commands_update` is not a new top-level `WireMessageV1` member.
- `apps/web`: `RelayClient.commandsFor(sessionId)` reads `TranscriptState.commands`, the same "derived from the one reduced state" shape `configOptionsFor` already uses. No UI wiring — that is #743's job.

An unrecognized/future field on a command (e.g. a future ACP `AvailableCommand` addition this client has never modeled) survives the whole round trip rather than being dropped: `acpAvailableCommandV1` is `.passthrough()`ed, not `.strict()`, and `mapAvailableCommands` spreads each wire entry through instead of reconstructing a picked-fields object — `AcpAvailableCommand` itself carries an index signature for exactly this, the same passthrough convention `AcpContentBlock` already uses for an unmodeled ACP content-block variant.

Verified against the real `omp acp` binary (v17.2.9, reachable on this box): recorded a live `initialize` -> `session/new` -> `session/prompt` exchange to confirm `available_commands_update` only ever arrives as a notification during a turn, never seeded on `session/new` unlike config options (`test/fixtures/omp-acp-available-commands-update.json`), then drove the fixture end to end (`config-acp-agent.mjs`'s new `"trigger-commands"` prompt) through a real `AcpClient`, a real `NodeDaemon`/relay/`RelayClient` round trip, and the browser-side zod validation, each with a command carrying an unrecognized field to prove it survives every layer.
