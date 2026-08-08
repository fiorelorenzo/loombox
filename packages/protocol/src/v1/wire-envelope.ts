import { PROTOCOL_V1 } from './handshake';
import type { WireMessageV1 } from './message';

/**
 * Builds a v1 outbound wire message, defaulting `protocolVersion` to
 * {@link PROTOCOL_V1} instead of making every call site retype the literal
 * (issue #921 — 194 sites across `apps/web`'s `relay-client.ts` and
 * `packages/node`'s `node-daemon.ts` did exactly that). `fields` carries
 * every field the `type`'s own `WireMessageV1` variant needs besides `type`
 * and `protocolVersion` — including `requestId`, which this helper does not
 * generate; callers still produce it the same way they did before (a fresh
 * id, an echoed inbound id, or omitted for fire-and-forget messages),
 * keeping this a pure envelope wrapper with no behavioural change.
 *
 * The `Extract`/`Omit` pair is what keeps each variant's own required
 * fields intact rather than widening the parameter to
 * `Partial<WireMessageV1>` — passing `target_list_request` still requires
 * `requestId`, passing `ping` still requires `nonce`, etc.
 */
export function withEnvelope<T extends WireMessageV1['type']>(
  type: T,
  fields: Omit<Extract<WireMessageV1, { type: T }>, 'type' | 'protocolVersion'>,
): Extract<WireMessageV1, { type: T }> {
  return { type, protocolVersion: PROTOCOL_V1, ...fields } as Extract<WireMessageV1, { type: T }>;
}
