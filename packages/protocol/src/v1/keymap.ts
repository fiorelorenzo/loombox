import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Wire surface for the user-editable, per-account keyboard keymap
 * (Zed-parity F3-3, issue #760, building on F1-3/#758's action registry and
 * F2-3/#759's default binding set). Every entry maps a **permanent** action
 * id (`apps/web/src/lib/action-registry.ts`'s own `ActionDefinition.id` —
 * that module's doc comment records the hard rule issue #760's own comment
 * thread restates: action ids never get renamed once this ships) to a chord
 * string in this app's own `Mod+[Shift+][Alt+]<Key>` convention
 * (`keyboard.ts`'s `matchesShortcut`) — deliberately NOT the Zed-style
 * `mod-.` spelling `docs/design/zed-parity-2026-08-05/section-f-keyboard.
 * html`'s mockup sketches, since that is not what this app's matcher
 * actually parses.
 *
 * Deliberately just `Record<actionId, chord>` — no per-entry `context`
 * override (the mockup's `{binding, context}` shape). A remap only ever
 * changes WHICH chord triggers an action, never WHEN it is allowed to fire:
 * the action's own `isAvailable`/`shortcutFor` predicate (#758/#759) still
 * fully governs that, unconditionally, for a remapped entry exactly like an
 * unremapped one. Building a user-facing predicate language was never in
 * this issue's acceptance criteria, and "context predicates possible" is
 * satisfied by the registry's own predicates continuing to apply.
 *
 * This schema validates wire SHAPE only (every key and value a non-empty
 * string) — the relay has no `actionRegistry` to check ids or conflicts
 * against, so it stays exactly as blind to "is this a real action id" as
 * `permission-policy.ts`'s glob-pattern schema is to "is this glob well
 * formed". `apps/web/src/lib/keymap.ts`'s `validateKeymapCandidate` is
 * where a candidate keymap is actually checked against the live registry,
 * client-side, before it is ever sent (mirrors `PermissionPolicyPanel.
 * svelte`'s own pre-send blank-glob check) — an invalid or conflicting
 * candidate never reaches this schema, or the relay, at all.
 *
 * The payload travels sealed under `@loombox/crypto`'s `deriveKeymapKey`
 * (`['keymap', accountId]`, the account-scoped sibling of
 * `deriveSessionKey`/`deriveProjectKey`) — no node, no session, no project
 * involved at all, since a keymap is a pure account/UI concern that must
 * work with zero of any of those. The relay only ever stores/forwards the
 * resulting `EncryptedEnvelope`, exactly like every other content family.
 */
export const keymapV1 = z.record(z.string().min(1), z.string().min(1));
export type KeymapV1 = z.infer<typeof keymapV1>;

/**
 * A client asks the relay for its account's saved keymap — sent proactively
 * on every fresh connection (`RelayClient`'s handshake handler, alongside
 * `session_list_request`/`connected_account_list_request`), so a brand-new
 * device sees the current keymap the moment it signs in, with no explicit
 * user action. `envelope: null` on the reply (never an error) is the "this
 * account has never saved one" case — every action still uses its built-in
 * default, mirroring `EscrowStore.get`'s "nothing escrowed yet" contract.
 */
export const keymapGetRequest = z.object({
  type: z.literal('keymap_get_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
});
export type KeymapGetRequest = z.infer<typeof keymapGetRequest>;

/**
 * A client asks the relay to save (fully replace — never a partial patch,
 * the same whole-document contract `permission_policy_set` follows) its
 * account's keymap. The relay accepts whatever well-formed envelope it is
 * given; every semantic check (unknown action id, malformed chord,
 * conflicting bindings) already happened client-side before this was sent —
 * see `keymapV1`'s own doc comment.
 */
export const keymapSetRequest = z.object({
  type: z.literal('keymap_set_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type KeymapSetRequest = z.infer<typeof keymapSetRequest>;

/**
 * The relay's reply to `keymap_get_request`/`keymap_set_request` — the
 * account's current saved keymap envelope, or `null` if nothing has ever
 * been saved. Also pushed, unprompted, to every OTHER live connection on
 * the same account the instant a `keymap_set_request` lands (issue #760's
 * "a merge story for the same account editing from two tabs" cost) —
 * `requestId` is only meaningful to whichever connection actually sent the
 * request this answers; every other recipient has no pending request to
 * resolve, so it just applies the payload to its own live view instead. A
 * stronger guarantee than `permission_policy_result`'s requestId-only
 * handling, deliberately: a stale keymap's failure mode (silently pressing
 * a chord the UI no longer shows as bound to that action) is worse than a
 * policy panel merely looking stale until its own next open.
 */
export const keymapResult = z.object({
  type: z.literal('keymap_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope.nullable(),
});
export type KeymapResult = z.infer<typeof keymapResult>;
