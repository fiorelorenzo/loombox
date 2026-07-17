import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Wraps one encrypted ACP transcript update for fan-out (SPEC §7.24, §5.5,
 * §16). The decrypted plaintext inside `envelope` is one of
 * `@loombox/providers-core`'s `AcpTranscriptUpdate` variants (message/thought
 * chunks, `tool_call`/`tool_call_update`, `plan_update`, `usage_update`,
 * providers/core/src/transcript.ts) — this package does NOT re-declare that
 * union; to the wire and the relay it is opaque ciphertext. `seq` is
 * monotonic per session, the resync primitive (SPEC §7.16, §7.22): a client
 * that reconnects with a `ResyncRequest.sinceSeq` gets replayed every
 * envelope with a higher `seq` for that session, still without the relay
 * ever decrypting any of them.
 */
export const sessionUpdateEnvelopeV1 = z.object({
  type: z.literal('session_update'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  envelope: encryptedEnvelope,
});
export type SessionUpdateEnvelopeV1 = z.infer<typeof sessionUpdateEnvelopeV1>;
