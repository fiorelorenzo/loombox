import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Device-switch state preservation (issue #198, epic #6; SPEC §7.3
 * "switch device mid-session with state preserved, borrowing Happy's
 * per-session invalidate/caching approach as inspiration").
 *
 * Most of "where I was" is already recoverable without any of this: the
 * transcript itself resyncs (issue #729's `resync_request`/`seq` high-water
 * mark), and the session list/`ClientSessionMeta` reload the same way on
 * every fresh connection. What is NOT recoverable from state the client
 * already syncs is per-device UI/reading-position state that never had a
 * wire representation at all — the composer's unsent draft, which canvas
 * tab was open, and which transcript item the reader had scrolled to. This
 * schema is that missing piece: one small, session-scoped record, fully
 * replaced on every save (never a partial patch, the same whole-document
 * contract `keymap.ts`'s `keymapSetRequest` already follows), sealed under
 * the session's own `deriveSessionKey` (`@loombox/crypto`) so the relay —
 * which stores and fans it out — never sees a byte of it in the clear. The
 * composer draft in particular is user-authored content; it must never
 * reach the relay unsealed, exactly like a prompt itself never does.
 *
 * `revision` is the writing device's own {@link SessionMetaPublic}-adjacent
 * high-water mark at write time — the client's own `session_update.seq`
 * this device had applied when it captured the view (mirrors issue #729's
 * `lastAppliedSeqBySession`). It travels on the wire mainly as a documented
 * anchor for "how current was this device when it wrote this" — the actual
 * per-session invalidate Happy's approach inspired lives client-side
 * (`apps/web/src/lib/session-view-state.ts`'s `invalidateStaleViewState`):
 * a `lastViewedItemId` that no longer resolves against the reading
 * device's own freshly-resynced transcript (the session advanced past what
 * this device could recover, e.g. evicted by the relay's bounded resync
 * ring — see `TranscriptGap`) is dropped back to "no anchor" rather than
 * trusted blindly, so a stale cache never points at nothing or silently
 * fails to jump; it falls back to the same live-tail default a session
 * with no saved view state ever had.
 */

/**
 * A client asks the relay for a session's saved view state — sent the
 * first time a caller shows interest in a given session (mirrors
 * `keymap_get_request`'s "sent proactively" contract, just session- rather
 * than account-scoped) and again on every reconnect for a session already
 * being watched, so a device that was disconnected while another advanced
 * the session picks up whatever that other device last saved. `envelope:
 * null` on the reply is "nothing saved for this session yet" — every
 * caller falls back to its own defaults (empty draft, transcript tab,
 * live tail), never an error.
 */
export const sessionViewStateGetRequest = z.object({
  type: z.literal('session_view_state_get_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type SessionViewStateGetRequest = z.infer<typeof sessionViewStateGetRequest>;

/**
 * A client asks the relay to save (fully replace) a session's view state.
 * The relay never inspects `envelope` — every semantic check already
 * happened client-side (the payload this seals is `sessionViewStatePayloadV1`
 * below) — and stores it keyed by `sessionId` alone: session ownership
 * (`record.meta.accountId === connection.accountId`) is checked once,
 * relay-side, against the existing session store, the same guard
 * `session_resume` already applies.
 */
export const sessionViewStateSet = z.object({
  type: z.literal('session_view_state_set'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  envelope: encryptedEnvelope,
  revision: z.number().int().nonnegative(),
});
export type SessionViewStateSet = z.infer<typeof sessionViewStateSet>;

/**
 * The relay's reply to `session_view_state_get_request`/
 * `session_view_state_set` — the session's current saved view-state
 * envelope, or `null` if nothing has ever been saved. Also pushed,
 * unprompted, to every OTHER live connection on the same account the
 * instant a `session_view_state_set` lands (mirrors `keymap_result`'s own
 * cross-tab/cross-device push): a device that is live RIGHT NOW while
 * another device saves a new draft/panel/position sees it applied
 * immediately, not only on its own next reconnect. `requestId` is only
 * meaningful to whichever connection sent the request this answers; every
 * other recipient has no pending request to resolve and just applies the
 * payload to its own live view instead — identical contract to
 * `keymap_result`'s own doc comment.
 */
export const sessionViewStateResult = z.object({
  type: z.literal('session_view_state_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  envelope: encryptedEnvelope.nullable(),
  revision: z.number().int().nonnegative(),
});
export type SessionViewStateResult = z.infer<typeof sessionViewStateResult>;

/**
 * Which canvas tab was open (`apps/web/src/lib/tabs.svelte.ts`'s
 * `CanvasTab`, minus its ephemeral fetched content — a diff/graph/file's
 * own content is always re-fetched fresh on open, exactly like opening it
 * from scratch on the SAME device already does; only the tab's identity
 * needs to survive). `'file'` alone carries `path`, the same project-
 * relative key `CanvasTabsState.open` already uses to activate-or-open.
 */
export const sessionViewStatePanelV1 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transcript') }),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({ kind: z.literal('diff') }),
  z.object({ kind: z.literal('graph') }),
]);
export type SessionViewStatePanelV1 = z.infer<typeof sessionViewStatePanelV1>;

/**
 * The plaintext a `session_view_state_*` envelope decrypts to — the other
 * half of the boundary the wire schemas above describe. `draft` is the
 * composer's unsent text (never the removable `@`-mention pills alongside
 * it, which reference live, device-local picker state — re-typing `@`
 * re-resolves them on the receiving device rather than trusting a foreign
 * device's resolved list). `lastViewedItemId` is a stable
 * `TranscriptItem.id` (issue #740's own turn-review anchor shape),
 * `undefined` while the writing device was pinned to the live tail — see
 * this module's own top-of-file doc comment for how a stale one gets
 * invalidated on read rather than trusted blindly.
 */
export const sessionViewStatePayloadV1 = z.object({
  draft: z.string(),
  panel: sessionViewStatePanelV1,
  lastViewedItemId: z.string().min(1).optional(),
});
export type SessionViewStatePayloadV1 = z.infer<typeof sessionViewStatePayloadV1>;

/** Parses and validates a decrypted session view-state payload, throwing on an invalid one. */
export function parseSessionViewStatePayloadV1(data: unknown): SessionViewStatePayloadV1 {
  return sessionViewStatePayloadV1.parse(data);
}

/** Same as {@link parseSessionViewStatePayloadV1} but never throws; returns zod's result. */
export function safeParseSessionViewStatePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SessionViewStatePayloadV1> {
  return sessionViewStatePayloadV1.safeParse(data);
}
