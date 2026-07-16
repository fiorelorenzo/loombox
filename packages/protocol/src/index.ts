import { z } from 'zod';

/**
 * The wire-protocol version, negotiated once per connection following ACP's
 * `initialize` handshake pattern (SPEC §10, §16). Bump on any
 * backwards-incompatible change to the schemas below.
 *
 * BOOTSTRAP: this package currently only carries the version and a base
 * message. The full v0 message set (NodeHello / ClientHello / SessionAnnounce /
 * SessionUpdateEnvelope / PromptInject) lands under the "Wire protocol" epic.
 */
export const PROTOCOL_VERSION = 0;

/** Fields every wire message carries so the receiver can gate on version. */
export const baseMessage = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type BaseMessage = z.infer<typeof baseMessage>;

/** Registry of the wire schemas; filled out as the protocol grows. */
export const schemas = {
  baseMessage,
} as const;
