import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Steering (follow-up prompts) and the tool-call permission FIFO queue
 * (SPEC §7.3, §7.24). The prompt text and the permission request's
 * `ToolCallUpdate` are session content like any transcript item, so both
 * travel as an opaque `encryptedEnvelope`; only routing fields
 * (`sessionId`, `promptId`/`requestId`) and, for the response, the user's
 * plaintext decision are clear.
 */

/** A client asks the relay to forward a follow-up prompt to a session (v1 counterpart of v0's `prompt_inject`, now encrypted). */
export const promptInjectV1 = z.object({
  type: z.literal('prompt_inject'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  promptId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type PromptInjectV1 = z.infer<typeof promptInjectV1>;

/** ACP's own permission-decision vocabulary (SPEC §7.24: `options[]`/`kind`), mapped by each provider adapter onto its own button set. */
export const permissionDecision = z.enum([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);
export type PermissionDecision = z.infer<typeof permissionDecision>;

/** A session asks a client to resolve a tool-call permission request (SPEC §7.24's FIFO queue); the request body is opaque, encrypted content. */
export const permissionRequest = z.object({
  type: z.literal('permission_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type PermissionRequest = z.infer<typeof permissionRequest>;

/** A client resolves a pending permission request. The decision itself stays clear (routing, not content) so the relay can fan it out without decrypting. */
export const permissionResponse = z.object({
  type: z.literal('permission_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  decision: permissionDecision,
});
export type PermissionResponse = z.infer<typeof permissionResponse>;

/**
 * A client picks a config option in the session's model/mode/reasoning-
 * effort bar (SPEC §7.24). `category` is the ACP config-option category
 * (`model`, `mode`, `thought_level`, or a future one — SPEC §7.24 requires
 * an unrecognized category to still render generically, so this schema does
 * not enumerate categories as a closed set).
 */
export const configOption = z.object({
  type: z.literal('config_option'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  category: z.string().min(1),
  optionId: z.string().min(1),
});
export type ConfigOption = z.infer<typeof configOption>;

const configOptionOk = z.object({ outcome: z.literal('ok') });
const configOptionError = z.object({
  outcome: z.literal('error'),
  message: z.string().min(1),
});
/** The owning node's outcome for one `config_option` request: `'ok'` once the agent's own `session/set_config_option` ack lands (the reconciled catalog itself rides the ordinary `config_options` session-lifecycle event, not duplicated here), or `'error'` with the agent's own rejection reason (issue #707's `error.data.details` folded into `AcpClient.setConfigOption`'s thrown `Error`) so a refusal is never silently dropped (issue #718). */
export const configOptionSetResult = z.discriminatedUnion('outcome', [
  configOptionOk,
  configOptionError,
]);
export type ConfigOptionSetResult = z.infer<typeof configOptionSetResult>;

/**
 * The owning node's reply to a client's `config_option` (SPEC §7.24; issue
 * #718). Unlike `permission_response`'s fire-and-forget: picking a config
 * option is a real ACP round trip (`session/set_config_option`) the agent
 * can reject (an unsupported value, an unknown option), and issue #718's
 * whole point is that a rejection has to actually reach a client instead of
 * dying in a node-side `console.warn` — the #702 failure mode this closes.
 *
 * Correlated to the request by `sessionId` + `category`, not a dedicated
 * request id: `configOption` above has never carried one (issue #149's
 * original design — picking a category's value is idempotent, no queue to
 * track), and `category` is already the natural key every config-option
 * store in this codebase groups on. A client with no pending request for
 * that category (a sibling device's own attempt, or a reply that arrived
 * after this client's own bookkeeping already cleared) simply ignores it —
 * same filtering `fs_list_response`'s own doc comment describes for
 * `requestId`.
 *
 * Fanned out to every client subscribed to the session exactly like
 * `fs_list_response`/`terminal_opened` (`relay.ts`'s `fanOutDirect`), not
 * routed to the requester alone: any subscriber's own catalog view can be
 * stale until this arrives.
 *
 * Clear, not an encrypted envelope: `configOption`'s own `category`/
 * `optionId` already travel in the clear (SPEC §8 does not treat a config-
 * option choice as private the way a prompt or file path is), so this
 * reply mirrors that rather than inventing an encryption boundary the
 * request itself doesn't have.
 */
export const configOptionResult = z.object({
  type: z.literal('config_option_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  category: z.string().min(1),
  result: configOptionSetResult,
});
export type ConfigOptionResult = z.infer<typeof configOptionResult>;

const promptInjectOk = z.object({ outcome: z.literal('ok') });
const promptInjectError = z.object({
  outcome: z.literal('error'),
  message: z.string().min(1),
});
/** The owning node's outcome for one `prompt_inject` (issue #706): `'ok'` once the prompt has actually been handed to a live agent process — including one this same reply's own delivery just revived, for a session reloaded `'disconnected'` after a node restart (SPEC §7.1's "sessions can be ... reconnected") — or `'error'` naming why it could not be, e.g. reviving that agent failed, or the session is paused on a spend cap (SPEC §7.16). Mirrors `configOptionSetResult`'s own shape exactly. */
export const promptInjectSendResult = z.discriminatedUnion('outcome', [
  promptInjectOk,
  promptInjectError,
]);
export type PromptInjectSendResult = z.infer<typeof promptInjectSendResult>;

/**
 * The owning node's reply to a client's `prompt_inject` (issue #706).
 * Before this, `prompt_inject` carried no reply channel at all: a prompt
 * typed into a session with no live agent behind it (reloaded
 * `'disconnected'` after a restart, or `'paused'` on a spend cap) was
 * dropped with nothing but a node-side `console.warn` — the client had no
 * way to ever learn its message went nowhere. This closes that gap the
 * same way `configOptionResult` (issue #718) already closed it for
 * `config_option`.
 *
 * Correlated by `promptId` (already on every `prompt_inject`, issue
 * #128's original queue-tracking id), not fanned out unconditionally the
 * way `configOptionResult` is: only the ONE case this reply exists for —
 * a prompt that could not simply be handed to an already-live agent, so a
 * reply is actually worth sending — is answered. A prompt that reaches an
 * already-live agent gets no reply at all, same as before this issue:
 * the transcript itself is the feedback (SPEC §7.24's turn lifecycle),
 * and inventing a synthetic "ok" for a path that already visibly works
 * would just be wire noise.
 *
 * Clear, not an encrypted envelope, for the same reason `configOptionResult`
 * is clear: `message` never repeats prompt content, only a node-side
 * outcome/reason (SPEC §8's metadata boundary).
 */
export const promptInjectResult = z.object({
  type: z.literal('prompt_inject_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  promptId: z.string().min(1),
  result: promptInjectSendResult,
});
export type PromptInjectResult = z.infer<typeof promptInjectResult>;
