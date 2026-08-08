---
'@loombox/protocol': minor
'@loombox/web': patch
'@loombox/node': patch
---

One `withEnvelope` helper for the 194 wire-message call sites that hand-rebuilt `{ type, protocolVersion, requestId }` (issue #921, ref #652).

`@loombox/protocol` gains `withEnvelope(type, fields)`: defaults `protocolVersion` to `PROTOCOL_V1` and, via `Extract<WireMessageV1, { type: T }>`, keeps each message type's own required fields intact instead of widening to `Partial<WireMessageV1>`. It does not generate `requestId` itself — callers still produce it exactly as before (a fresh id, an echoed inbound id, or omitted for fire-and-forget messages) — so this is a pure envelope wrapper with no behavioural change.

Adopted at 189 of the 194 sites the issue counted: 89 of `apps/web/src/lib/relay-client.ts`'s 94 and all 100 of `packages/node/src/node-daemon.ts`'s. Left alone, by design: `relay-client.ts`'s `getAccountPins`/`setAccountPin`/`unsetAccountPin`/`getTrackerMode`/`setTrackerMode` (5 sites) build a message deliberately missing `requestId` — `sendAccountPinRequest`/`sendTrackerModeRequest` generate it afterwards and splice it in (`{ ...message, requestId }`) so a shared timeout/dedupe path owns exactly one `requestId` per family instead of five call sites each minting their own. `withEnvelope`'s return type always includes every field the wire type requires, `requestId` included, so it does not fit that split-construction shape without either weakening the helper's guarantee or making those five call sites pass a throwaway placeholder `requestId` — worse than leaving the pre-existing pattern in place.

`packages/relay/src/relay.ts`'s own ~19 sites of the same shape (noted in #921 as a natural extension) are left for a follow-up: this PR is already the largest mechanical diff of the wave, in the repo's two most actively-touched files; folding in a third file and a different call pattern (the relay is the routing layer, not a session-scoped client/node) buys nothing acceptance-wise and only grows the reviewable surface.

No wire format change: every migrated site is verified byte-identical (same `type`, same `protocolVersion`, same other fields) — the AST codemod moved only `protocolVersion: PROTOCOL_V1` into the helper. `relay-client.test.ts`, `node-daemon*.test.ts`, and the full protocol schema suite pass unmodified.
