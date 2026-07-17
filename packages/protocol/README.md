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

v0 is disposable: it stays exported and tested as-is until every downstream
package (relay, node, apps/web) has migrated to v1, at which point it is
removed in a later cleanup (not part of this package's job to schedule).

## Messages (v1)

v1 (issues #106/#107/#109, `docs/v1-plan.md`, issue #315's locked
architecture decisions) is additive alongside v0 above: same package, a
separate `wireMessageV1` discriminated union, `PROTOCOL_V1 = 1`, and its own
`parseWireMessageV1`/`safeParseWireMessageV1`. Every v0 export is untouched.

**The relay-blind boundary.** v1 wires full end-to-end encryption through:
the relay only ever forwards/stores ciphertext plus a narrow set of clear,
relay-indexable routing metadata (SPEC §8's "bridge" bullet). Concretely:

- `EncryptedEnvelope` is the JSON-safe wire form of `@loombox/crypto`'s
  AAD-bound `Envelope` (`resourceId`, base64 `iv`/`ciphertext`, `alg`). Every
  encrypted payload below is one of these; the relay treats it as opaque
  bytes it never decrypts.
- `SessionMetaPublic` (`id`, `nodeId`, `targetId`, `accountId`, `provider`,
  `createdAt`, optional `seq`) is the ONLY session metadata that sits in the
  relay's Postgres in the clear, gated by `owner_account_id` so a logged-in
  client can list "your sessions across all your nodes" without a QR every
  time. It carries no `title` and no `projectPath` — those travel only inside
  a paired `EncryptedEnvelope` (`SessionWithPrivateEnvelope`), opaque to the
  relay. `session_create`/`session_announce`/`session_list` all split their
  payload this way.

Message families, grouped as in `docs/v1-plan.md`:

- **Handshake + version** — `Initialize` (`initialize`): a node or client's
  first message, carrying `protocolVersion`, `role` (`node`/`client`), an
  opaque Better Auth Bearer `authToken`, `deviceId`, and the device's base64
  ECDH P-256 `devicePublicKey`. `InitializeResult` (`initialize_result`)
  replies with the connection's `negotiatedVersion` and a `capabilities` set.
  `negotiateVersion(localVersions, remoteVersions)` is the pure
  highest-common-version helper behind that negotiation (returns `null` on no
  overlap); `SUPPORTED_PROTOCOL_VERSIONS` is the set this package validates
  (`{0, 1}`).
- **Auth + devices** — `DeviceRegister`/`DeviceRevoke`/`DeviceRotate` manage
  the device registry; `DeviceRevoke` carries the freshly-minted AMK epoch,
  ECDH-wrapped per surviving device (`rewrappedAmk`). `AmkEscrow` uploads the
  recovery-code-wrapped AMK as an opaque base64 blob.
  `NewDeviceBootstrapRequest`/`Response` is the recovery-code bootstrap path;
  `QrPairingRequest`/`Response` is the device-to-device fast path (SPEC §8).
- **Targets + sessions** — `TargetAnnounce` publishes a node's `local`/`ssh`
  targets (SPEC §5.2). `SessionCreate`/`SessionAnnounceV1`/`SessionResume`/
  `SessionListRequest`/`SessionListV1` are the session lifecycle, all split
  per the metadata boundary above.
- **Session updates** — `SessionUpdateEnvelopeV1` (`session_update`) wraps
  one encrypted ACP transcript update per session, tagged with a
  per-session monotonic `seq`. The decrypted plaintext is one of
  `@loombox/providers-core`'s `AcpTranscriptUpdate` variants (message/thought
  chunks, `tool_call`/`tool_call_update`, `plan_update`, `usage_update`,
  SPEC §7.24) — this package does not re-declare that union; to the wire it
  is opaque ciphertext.
- **Steering + permissions** — `PromptInjectV1` (`prompt_inject`) carries an
  encrypted follow-up prompt. `PermissionRequest`/`PermissionResponse` are
  the tool-call permission FIFO queue (SPEC §7.24), the request body
  encrypted and the response's `decision` (ACP's `allow_once`/
  `allow_always`/`reject_once`/`reject_always`) clear. `ConfigOption` is a
  model/mode/reasoning-effort pick.
- **Attachments** — `BlobUpload`/`BlobRef`/`BlobDownload`/
  `BlobDownloadResponse` move encrypted attachment blobs by opaque `ref`
  (SPEC §7.25); the bytes never ride the session-update fan-out, only these
  dedicated messages.
- **Presence + resync** — `Presence` reports a device's online/offline
  transition. `ResyncRequest` (`sinceSeq`) asks the relay to replay buffered
  ciphertext envelopes for a session without decrypting them (SPEC §7.22).
  `ResyncMarker` is the bounded-backpressure drop notice (SPEC §7.16): sent
  instead of the dropped envelopes when a client's queue overflowed, so the
  client knows exactly which `seq` range it missed.

## Usage

```ts
import { parseWireMessage, safeParseWireMessage } from '@loombox/protocol'; // v0
import { parseWireMessageV1, safeParseWireMessageV1 } from '@loombox/protocol'; // v1

const msg = parseWireMessage(JSON.parse(raw)); // throws on an invalid v0 payload
const result = safeParseWireMessage(JSON.parse(raw)); // never throws

const msgV1 = parseWireMessageV1(JSON.parse(raw)); // throws on an invalid v1 payload
const resultV1 = safeParseWireMessageV1(JSON.parse(raw)); // never throws
```

Grounding (SPEC §10, §16): the protocol version is negotiated once per connection
following ACP's `initialize` handshake. Neither v0 nor v1 requires Socket.IO —
native WebSocket plus our own resync (seq + ring buffer) is a locked v1
architecture decision (issue #315): Socket.IO's `connectionStateRecovery`
replays server-side plaintext, which is useless when the relay is E2E-blind.
