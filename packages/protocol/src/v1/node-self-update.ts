import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/**
 * The node's own self-update surface (issue #656; epic #653). Distinct from
 * `target-lifecycle.ts`'s `targetUpdateRequest`/`targetUpdateResponse`,
 * which re-provisions the SUPERVISOR running on one of a node's `ssh:`
 * targets — this is the node's OWN process updating itself, using the
 * versioned bundle layout #817 built (`~/.loombox/versions/<version>/` +
 * a `current` symlink; `packages/node/src/install-layout.ts`). Kept as a
 * separate vocabulary on purpose: `targetVersionStatusV1`'s `'behind'`
 * already means "this target's supervisor differs from what THIS node is
 * pinned to", and `buildIdentityMismatch`'s "Behind" badge (issue #655)
 * already means "this peer's build differs from the relay's own" — neither
 * is "a newer release exists upstream", which is what this module answers,
 * so reusing either word here would make one badge mean two different
 * things. `'update_available'` is deliberately its own term.
 *
 * The epic is explicit that auto-updating without consent is out of scope
 * (#653's own "Out of scope" section): detecting and surfacing a newer
 * version costs the user nothing and needs no confirmation —
 * {@link nodeSelfUpdateStatusAnnounce} is a plain, unprompted push, exactly
 * like `target_status`. Only {@link nodeSelfUpdateApplyRequest} is gated
 * behind an explicit, one-tap in-app action.
 */

/** Mirrors `packages/node/src/self-update.ts`'s own `NodeUpdateStatus` field-for-field: whether a newer node build is known to exist. `'unknown'` covers both "never checked yet" and "the last check failed" — a receiver never guesses `'current'` for either. */
export const nodeSelfUpdateStatusV1 = z.enum(['current', 'update_available', 'unknown']);
export type NodeSelfUpdateStatusV1 = z.infer<typeof nodeSelfUpdateStatusV1>;

/**
 * A snapshot of one node's self-update check (issue #656). `currentVersion`
 * is this node's own running `@loombox/node` version (the same value its
 * `initialize.buildIdentity.version` carries); `latestVersion` is the
 * newest version the node's configured update source has found, absent
 * when the last check failed or none has completed yet. `checkedAt` is
 * milliseconds since epoch (the node's own clock), mirroring
 * `targetHealth.sampledAt`'s convention.
 */
export const nodeSelfUpdateSummaryV1 = z.object({
  status: nodeSelfUpdateStatusV1,
  currentVersion: z.string().min(1),
  latestVersion: z.string().min(1).optional(),
  checkedAt: z.number(),
});
export type NodeSelfUpdateSummaryV1 = z.infer<typeof nodeSelfUpdateSummaryV1>;

/**
 * A node pushes its latest self-update check, unprompted, whenever one
 * completes (on connect and on its own periodic interval —
 * `NodeSelfUpdateMonitor`'s own doc comment). Never a reply to a client
 * request: nothing about detecting an update needs the user's consent, so
 * there is no matching `_request` type, exactly like `target_status`.
 */
export const nodeSelfUpdateStatusAnnounce = z.object({
  type: z.literal('node_self_update_status'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  ...nodeSelfUpdateSummaryV1.shape,
});
export type NodeSelfUpdateStatusAnnounce = z.infer<typeof nodeSelfUpdateStatusAnnounce>;

/**
 * The explicit, one-tap "Update" action (issue #656's own consent
 * requirement): a client asks `nodeId` to update ITSELF to the version its
 * own last self-update check found. There is no `targetVersion` field on
 * purpose — a client can only ever act on what the node itself already
 * reported via {@link nodeSelfUpdateStatusAnnounce}, never name an
 * arbitrary version, so this can never race a check the node hasn't
 * announced yet.
 */
export const nodeSelfUpdateApplyRequest = z.object({
  type: z.literal('node_self_update_apply_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
});
export type NodeSelfUpdateApplyRequest = z.infer<typeof nodeSelfUpdateApplyRequest>;

/**
 * The acting node's reply, delivered back to the requesting client only —
 * routing metadata only, no envelope, same boundary as
 * `targetUpdateResponse` (an old/new version string is no more sensitive
 * than a target's own routing record). `ok: false` covers every refusal
 * and every failure this node's own `applyNodeSelfUpdate` can report: no
 * update source configured, nothing newer known, a session mid-turn
 * (drain-first — #653's own "never interrupts" requirement), a fetch/
 * signature/staged-verification failure (never activated), or an
 * activation failure that was rolled back. `toVersion` is present only
 * when `ok` is `true` — a failed attempt never reports having moved.
 */
export const nodeSelfUpdateApplyResponse = z.object({
  type: z.literal('node_self_update_apply_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  ok: z.boolean(),
  fromVersion: z.string().min(1),
  toVersion: z.string().min(1).optional(),
  message: z.string().min(1),
});
export type NodeSelfUpdateApplyResponse = z.infer<typeof nodeSelfUpdateApplyResponse>;
