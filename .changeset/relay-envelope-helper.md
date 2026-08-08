---
'@loombox/relay': patch
---

Adopts `@loombox/protocol`'s `withEnvelope` helper (issue #921/#934) at all 19 of `packages/relay/src/relay.ts`'s own `{ type, protocolVersion: PROTOCOL_V1, ...fields }` hand-rebuilds, the follow-up #934 left out to keep that PR from touching a third contested file (issue #935, epic #558).

All 19 sites are the relay originating its own reply or broadcast (a new type distinct from whatever inbound message prompted it, or a store-driven broadcast) — never a verbatim forward of a message it received, so every one structurally fits `withEnvelope` the same way #934's two files did. `protocolVersion: PROTOCOL_V1` no longer appears anywhere in `relay.ts` except the unrelated `RELAY_SUPPORTED_VERSIONS` negotiation constant. No wire format change, no behavioural change, `packages/relay`'s existing tests pass unmodified.
