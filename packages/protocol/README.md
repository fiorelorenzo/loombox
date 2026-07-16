# @loombox/protocol

The shared, versioned Zod wire schema imported by `@loombox/node`,
`@loombox/relay`, and the PWA client. One package, one source of truth for every
message that crosses the wire.

**Status: bootstrap.** This package currently exports only `PROTOCOL_VERSION` and
a `baseMessage` schema. The full v0 message set is defined under the "Wire
protocol" epic:

- `NodeHello` — a node registers with the relay
- `ClientHello` — a PWA client registers
- `SessionAnnounce` — a node tells the relay a session exists
- `SessionUpdateEnvelope` — wraps an ACP `session/update` for fan-out, tagged
  with a session id
- `PromptInject` — a client asks the relay to forward a follow-up prompt

Grounding (SPEC §10, §16): the protocol version is negotiated once per connection
following ACP's `initialize` handshake. v0 does not require Socket.IO; the
version-negotiation pattern is the point, not the transport library.
