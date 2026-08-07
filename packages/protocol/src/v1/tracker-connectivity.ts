import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Live tracker connectivity watcher wire shape (SPEC §7.10's "explicit
 * connectivity-error state"; issue #219) — the sibling of `ci-check.ts`'s
 * `ci_check_status`, same shape and same reasoning: `packages/node/src/
 * tracker-connectivity-watcher.ts` polls a live-mode project's
 * `TrackerBackend` on a fixed interval and this is what carries the result
 * back over the wire. One node-pushed message, no request: a client never
 * asks for it, it arrives whenever the node's own poll produces a fresh
 * reading. Session-scoped (not project-scoped) purely for delivery —
 * `NodeDaemon` polls once per PROJECT (`TrackerConnectivityWatcher` is
 * keyed by `projectPath`, never redundantly per session) and then pushes
 * the identical reading to every session currently open on that project,
 * reusing the exact same session-subscription fan-out `ci_check_status`
 * already rides (`packages/relay/src/relay.ts`'s `fanOutDirect`) rather
 * than inventing a second, project-keyed subscription registry in the
 * relay. `envelope` is sealed to the session key like every other
 * session-scoped push; the relay never opens it.
 *
 * `TrackerConnectivityStateV1.state` is three-way, not two, because the
 * corrective action differs and collapsing them would recreate this
 * issue's whole bug (an unreachable tracker must never look like an empty
 * one):
 * - `'reachable'` — the last poll's `TrackerBackend.list` call succeeded,
 *   whether or not it returned any items. A live tracker with zero open
 *   items is a normal, healthy state, not a failure — `recomputeAttentionInbox`
 *   never raises an inbox item for it.
 * - `'unreachable'` — the backend could not be reached, or answered but
 *   not usefully: network failure, timeout, a 5xx, or GitHub/Jira rate
 *   limiting. Purely transient from the user's point of view — "try again
 *   later", nothing to configure.
 * - `'authFailed'` — the credential this project's live tracker depends on
 *   was rejected (a resolution failure — no connected account, no pinned
 *   credential — or the remote API itself answered 401/403 for a reason
 *   other than rate limiting, i.e. an expired or revoked token). The
 *   corrective action is completely different from `'unreachable'`:
 *   reconnect the account in Settings, not "wait and retry".
 *
 * `provider` is carried alongside `state` (not just inferred from the
 * project's own `TrackerMode`) so a client can word the inbox item
 * ("GitHub"/"Jira") without a second lookup — mirrors `CiCheckStateV1`
 * carrying `prUrl`/`prNumber` rather than making a client re-derive them.
 */
export const trackerConnectivityStateV1 = z.object({
  state: z.enum(['reachable', 'unreachable', 'authFailed']),
  provider: z.enum(['github', 'jira']),
  /** Epoch ms this reading was produced — `TrackerConnectivityWatcher`'s own poll clock, injectable in tests. Backs the attention inbox's `waitingSince` sort key, same convention as `CiCheckStateV1.updatedAt`. */
  updatedAt: z.number(),
});
export type TrackerConnectivityStateV1 = z.infer<typeof trackerConnectivityStateV1>;

/** The plaintext a `tracker_connectivity_status` envelope decrypts to. */
export const trackerConnectivityStatusPayloadV1 = z.object({
  status: trackerConnectivityStateV1,
});
export type TrackerConnectivityStatusPayloadV1 = z.infer<
  typeof trackerConnectivityStatusPayloadV1
>;

/** Parses and validates a decrypted `tracker_connectivity_status` payload, throwing on an invalid one. */
export function parseTrackerConnectivityStatusPayloadV1(
  data: unknown,
): TrackerConnectivityStatusPayloadV1 {
  return trackerConnectivityStatusPayloadV1.parse(data);
}

/** Same as {@link parseTrackerConnectivityStatusPayloadV1} but never throws; returns zod's result. */
export function safeParseTrackerConnectivityStatusPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TrackerConnectivityStatusPayloadV1> {
  return trackerConnectivityStatusPayloadV1.safeParse(data);
}

/**
 * The owning node streams a session's project's latest live-tracker
 * connectivity reading — sent right after this session first joins a
 * watched project (from the watcher's next poll pass) and then on a fixed
 * interval after, whatever the resulting state (SPEC §7.10; issue #219).
 * Field shape mirrors `ci-check.ts`'s `ciCheckStatus` exactly; see this
 * module's own top comment for why session-scoped delivery, not
 * project-scoped.
 */
export const trackerConnectivityStatus = z.object({
  type: z.literal('tracker_connectivity_status'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TrackerConnectivityStatus = z.infer<typeof trackerConnectivityStatus>;
