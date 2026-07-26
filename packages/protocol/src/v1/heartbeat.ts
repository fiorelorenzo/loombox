import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/**
 * Application-level liveness probe, sent by either peer, answered by the
 * relay with a {@link pong} carrying the same `nonce` (issue #511).
 *
 * Why not a WebSocket protocol-level ping: the WHATWG `WebSocket` both the
 * node (Node 22's global, SPEC §5.1) and the browser use exposes no way to
 * *send* a ping or observe a pong, so a peer built on it cannot detect a
 * half-open socket — the state you get when the relay's container is killed
 * and no FIN ever arrives, which leaves the peer believing it is connected
 * forever. Only the relay's `ws` server can drive transport-level pings, and
 * those let the relay reap dead peers, not a peer notice a dead relay. So
 * liveness the peers can act on has to live on this wire.
 *
 * Not routed and not persisted: the relay answers on the same socket it
 * received this on, never forwarding it to a node or a client, so it carries
 * no session/target/account field and crosses no crypto boundary (SPEC §8).
 */
export const ping = z.object({
  type: z.literal('ping'),
  protocolVersion: z.literal(PROTOCOL_V1),
  /**
   * Echoed verbatim in the reply, so a peer can tell the answer to *this*
   * probe from a late answer to the previous one and never credits a stale
   * pong as proof the socket is alive right now.
   */
  nonce: z.string().min(1),
});
export type Ping = z.infer<typeof ping>;

/** The relay's reply to a {@link ping}, echoing its `nonce`. */
export const pong = z.object({
  type: z.literal('pong'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nonce: z.string().min(1),
});
export type Pong = z.infer<typeof pong>;

/**
 * The capability a relay advertises in `initialize_result` when it answers
 * {@link ping} (SPEC §5.5's capability negotiation, applied at the
 * connection level).
 *
 * Peers MUST arm a pong deadline only when this is present. A relay predating
 * issue #511 drops unknown frames silently rather than replying, so a peer
 * that assumed an answer would tear its own healthy connection down every
 * interval and never recover — strictly worse than the bug being fixed.
 */
export const HEARTBEAT_CAPABILITY = 'heartbeat';
