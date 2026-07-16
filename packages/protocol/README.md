# @loombox/protocol

The shared, versioned Zod wire schema imported by `@loombox/node`,
`@loombox/relay`, and the PWA client. One package, one source of truth for every
message that crosses the wire.

## Messages (v0)

Every message is a Zod object carrying `type` (the discriminator) and
`protocolVersion` (currently `PROTOCOL_VERSION = 0`), validated together as the
`wireMessage` discriminated union:

- `NodeHello` (`node_hello`) — a node registers with the relay.
- `ClientHello` (`client_hello`) — a PWA client registers with the relay.
- `SessionAnnounce` (`session_announce`) — a node tells the relay a session
  exists, carrying a `SessionMeta`.
- `SessionList` (`session_list`) — the relay's snapshot of known sessions,
  sent to a connecting client.
- `SessionUpdateEnvelope` (`session_update`) — wraps a `SessionUpdate` for
  fan-out, tagged with the `sessionId` it belongs to.
- `PromptInject` (`prompt_inject`) — a client asks the relay to forward a
  follow-up prompt to a session.

`SessionMeta` describes a running agent session (`id`, `nodeId`,
`projectPath`, `worktreePath`, a `target` of `'local'` in v0, `provider`, an
optional `title`, `createdAt`). `SessionUpdate` is a discriminated union on
`kind`, covering the subset of ACP `session/update` notifications v0 needs to
render a live view: `agent_message_chunk`, `user_message_chunk`,
`agent_turn_end`, and `error`.

## Usage

```ts
import { parseWireMessage, safeParseWireMessage } from '@loombox/protocol';

const msg = parseWireMessage(JSON.parse(raw)); // throws on an invalid payload
const result = safeParseWireMessage(JSON.parse(raw)); // never throws
```

Grounding (SPEC §10, §16): the protocol version is negotiated once per connection
following ACP's `initialize` handshake. v0 does not require Socket.IO; the
version-negotiation pattern is the point, not the transport library.
