import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/**
 * Issue #933, the relay-side follow-up from #929's 15-hour duplicate-node
 * incident (#937 already closed the same-machine half with a state-dir
 * lock — this is the half a lock can never see, because the two connections
 * aren't on the same machine). `relay.ts`'s `claimNodeRouting` decides what
 * happens when a SECOND connection announces (`target_announce`/
 * `session_announce`) a nodeId a DIFFERENT connection already holds live in
 * `registry.nodeConnectionsByNodeId`, by comparing `devicePublicKey` (an
 * ECDH identity persisted by `NodeIdentityStore` and reused across restarts,
 * issue #64 — announced on every `initialize`, #655's sibling field): the
 * one thing a genuinely different device cannot present.
 *
 * `outcome` names which of the two cases fired:
 *
 * - `'superseded'`: SAME devicePublicKey — an ordinary reconnect (a flaky
 *   network dropped a socket and the same physical node came back before
 *   the relay's own close/timeout noticed the old one was dead). The new
 *   connection takes over routing; this notice goes to the OLD connection,
 *   which is usually already dead or dying anyway.
 * - `'rejected'`: DIFFERENT devicePublicKey — a different device claiming
 *   an identity another connection already holds live. This is the actual
 *   #929 failure mode (or a plain misconfiguration): the relay refuses the
 *   NEWCOMER rather than evicting whatever session an operator might
 *   already be driving over the incumbent, and this notice goes to the
 *   newcomer, right before the relay closes it.
 *
 * Modeled on #108's `update_required` (a plain `type`+`message` refusal the
 * relay sends immediately before closing the socket) but, unlike
 * `update_required`, carried through the ordinary `WireMessageV1` union
 * rather than hand-rolled pre-handshake JSON: this only ever fires on a
 * connection that has already completed `initialize`, so there's no reason
 * to skip the schema the way the pre-handshake refusal has to.
 */
export const nodeIdentityConflictOutcome = z.enum(['superseded', 'rejected']);
export type NodeIdentityConflictOutcome = z.infer<typeof nodeIdentityConflictOutcome>;

/** A one-way notice the relay sends to whichever connection just lost a `nodeConnectionsByNodeId` claim — see this module's own doc comment and `relay.ts`'s `claimNodeRouting`. Never sent as a reply to anything (no `requestId`), exactly like `nodeSelfUpdateStatusAnnounce`. */
export const nodeIdentityConflict = z.object({
  type: z.literal('node_identity_conflict'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  outcome: nodeIdentityConflictOutcome,
  /** Human-readable, logged/displayable as-is — mirrors `update_required`'s own `message` field. */
  message: z.string().min(1),
});
export type NodeIdentityConflict = z.infer<typeof nodeIdentityConflict>;

/**
 * Mirrored onto every `TargetListEntry` row the SURVIVING node owns
 * (`targets.ts`'s `identityConflict` field) the moment `claimNodeRouting`
 * refuses a rival (issue #933) — so a client watching that node's Nodes
 * page sees it was just fought over instead of everything looking quietly
 * healthy, which is exactly how #929 stayed invisible for 15 hours.
 * Connection-scoped and sticky for that connection's whole lifetime, never
 * persisted in `TargetStore` and never auto-cleared on a timer — exactly
 * like `TargetListEntry.build`/`nodeSelfUpdate`: it naturally disappears
 * the moment this connection itself disconnects and a fresh one (with no
 * further rival) takes its place.
 */
export const nodeIdentityConflictWarning = z.object({
  /** The rejected rival's own `deviceId` — never its `devicePublicKey` or remote address, both of which stay server-side-log-only (issue #933's own "log the collision loudly" ask, in `relay.ts`). */
  rivalDeviceId: z.string().min(1),
  /** `Date.now()` at the moment the rival was rejected — lets a client show "just now" vs. "a while ago" rather than a bare boolean. */
  detectedAt: z.number().int().nonnegative(),
});
export type NodeIdentityConflictWarning = z.infer<typeof nodeIdentityConflictWarning>;
