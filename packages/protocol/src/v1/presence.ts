import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/** A device's online/offline transition, used for presence-aware push suppression (SPEC §7.11) and desktop-offline UX (§14). */
export const presence = z.object({
  type: z.literal('presence'),
  protocolVersion: z.literal(PROTOCOL_V1),
  deviceId: z.string().min(1),
  online: z.boolean(),
});
export type Presence = z.infer<typeof presence>;

/** A client asks the relay to replay every buffered ciphertext envelope for a session since `sinceSeq` (SPEC §7.16, §7.22). The relay replays without decrypting. */
export const resyncRequest = z.object({
  type: z.literal('resync_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  sinceSeq: z.number().int().nonnegative(),
});
export type ResyncRequest = z.infer<typeof resyncRequest>;

/**
 * The bounded/backpressure drop notice (SPEC §7.16: "bounded per-client
 * output queues with drop-oldest + a resync marker on overflow"). Sent
 * instead of the dropped envelopes themselves when a client's queue
 * overflowed, so the client knows it missed frames `fromSeq..toSeq` and must
 * re-fetch the affected range explicitly rather than silently rendering a
 * gap as if it were complete history.
 */
export const resyncMarker = z.object({
  type: z.literal('resync_marker'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
  dropped: z.boolean(),
});
export type ResyncMarker = z.infer<typeof resyncMarker>;
