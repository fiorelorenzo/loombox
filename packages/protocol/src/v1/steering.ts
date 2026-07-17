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
