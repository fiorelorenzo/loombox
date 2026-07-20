import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/**
 * Session-ownership leasing across nodes (SPEC §9: "a session is owned by
 * one node via a renewable lease... so a Mac node and a devbox node never
 * fight over the same supervisor"; §7.2's same-folder safety generalized
 * across processes rather than within one; issues #82/#104). This is
 * ROUTING/coordination metadata only — which node currently owns a session,
 * and until when — never session content, so the relay legitimately
 * arbitrates it, exactly like the device registry (SPEC §8's metadata
 * boundary; `devices.ts`'s doc comment). No encrypted payload here at all.
 *
 * A session is owned by a node, never by a client device, so all four
 * messages below are node -> relay -> node: `lease_request` (`action:
 * 'acquire' | 'renew'`) answered by `lease_result`, and `lease_release`
 * answered by `lease_release_result`. `relay.ts` wires these into
 * `handleNodeMessage` exactly like `target_announce`/`session_announce`.
 *
 * The wire shape mirrors `packages/node/src/ssh/session-lease.ts`'s
 * `SessionLeaseManager`/`LeaseAcquireResult` (the pre-existing local/
 * in-memory client and its `acquire`/`renew`/`release` semantics) — this
 * module is that same contract's arbitrated-over-the-wire form, so a
 * `RelayLeaseStore` can implement `session-lease.ts`'s own `LeaseStore`
 * interface against these messages without changing that manager's
 * acquire/renew/release/reclaim semantics at all.
 */

export const leaseRequestAction = z.enum(['acquire', 'renew']);
export type LeaseRequestAction = z.infer<typeof leaseRequestAction>;

/**
 * `acquire`: granted immediately if the session's lease is unheld, already
 * expired, or already held by this same `nodeId` (idempotent re-acquire).
 * `renew`: extends an already-held lease's expiry; denied (never granting a
 * fresh lease) if `nodeId` is not the session's current live holder — a
 * renewal is never a back-door acquire.
 */
export const leaseRequest = z.object({
  type: z.literal('lease_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  nodeId: z.string().min(1),
  action: leaseRequestAction,
  /** Requested lease lifetime in ms; the relay is the authority on the actual grant and may clamp this rather than trust an arbitrary caller value. */
  ttlMs: z.number().int().positive().optional(),
});
export type LeaseRequest = z.infer<typeof leaseRequest>;

export const leaseGrant = z.object({
  outcome: z.literal('granted'),
  expiresAt: z.number().int().nonnegative(),
});
export type LeaseGrant = z.infer<typeof leaseGrant>;

/**
 * Denied — either another node holds a still-live lease (`heldBy` names it),
 * or (for a `renew`) `nodeId` is no longer the live holder. `heldBy`/
 * `expiresAt` are both omitted only when there is nothing to report at all
 * (a `renew` denial for a session with no lease on record — already expired
 * and never re-acquired).
 */
export const leaseDenial = z.object({
  outcome: z.literal('denied'),
  heldBy: z.string().optional(),
  expiresAt: z.number().int().nonnegative().optional(),
});
export type LeaseDenial = z.infer<typeof leaseDenial>;

export const leaseOutcome = z.discriminatedUnion('outcome', [leaseGrant, leaseDenial]);
export type LeaseOutcome = z.infer<typeof leaseOutcome>;

/** The relay's reply to `lease_request`, correlated by `requestId`. */
export const leaseResult = z.object({
  type: z.literal('lease_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  result: leaseOutcome,
});
export type LeaseResult = z.infer<typeof leaseResult>;

/** A node deliberately gives up a lease it holds (session stop, node exit — SPEC §9). */
export const leaseRelease = z.object({
  type: z.literal('lease_release'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  nodeId: z.string().min(1),
});
export type LeaseRelease = z.infer<typeof leaseRelease>;

/** The relay's reply: whether it actually released — `false` if `nodeId` did not hold the lease (never releases another node's lease). */
export const leaseReleaseResult = z.object({
  type: z.literal('lease_release_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  released: z.boolean(),
});
export type LeaseReleaseResult = z.infer<typeof leaseReleaseResult>;
