import { z } from 'zod';

/**
 * Zod validation for the ACP-native half of `AcpSessionWireEvent`
 * (`AcpTranscriptUpdate`'s five kinds: the two message/thought-chunk kinds,
 * `tool_call`/`tool_call_update`, `plan_update`, `usage_update`) plus the
 * `session/request_permission` payload (an `AcpToolCallUpdate` plus the
 * `AcpPermissionOption[]` it's asking about) — everything `@loombox/node`
 * seals into a `session_update`/`permission_request` envelope that is this
 * package's own ACP-passthrough surface to validate (issue #593; root cause
 * behind #548: `AcpToolCallUpdate.id` is declared `string` but nothing ever
 * checked a decrypted payload actually had one).
 *
 * `AcpSessionWireEvent`'s OTHER half — the five loombox-invented
 * session-lifecycle kinds (`session_status`/`config_options`/
 * `config_option_update`/`turn_started`/`turn_ended`) — is deliberately NOT
 * re-validated here: `@loombox/protocol`'s `session-events.ts` already is
 * "their one validated source of truth" (that file's own doc comment), for
 * the same "zero workspace dependencies" reason this package cannot import
 * it back (`types.ts`'s doc comment on `AcpSessionLifecycleEvent`).
 * `apps/web`'s `relay-client.ts` is the one place that already depends on
 * both `@loombox/protocol` and this package, so it is where a decrypted
 * `session_update` payload is tried against both halves and combined into
 * one `AcpSessionWireEvent`.
 *
 * Callers use `.parse()`/`.safeParse()` on the schemas below directly
 * (`relay-client.ts`'s `parseSessionWireEvent`); this module only owns the
 * shapes, not a parse-boundary API of its own.
 *
 * Every object schema below deliberately does NOT `.strict()`: an unknown
 * extra field (from a newer provider/node) is stripped, not rejected, so an
 * older client degrades to "field absent" instead of the whole payload
 * being dropped. What DOES get rejected is a *known* field with the wrong
 * type, or a required field missing entirely — the actual gap `id: string`
 * (declared) vs. `id: undefined` (real, issue #548) left open.
 */

const acpDiffSchema = z.object({
  path: z.string(),
  oldText: z.string().nullable(),
  newText: z.string(),
});

const acpToolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'other',
]);

const acpToolCallStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed']);

function acpToolCallVariantSchema(kind: 'tool_call' | 'tool_call_update') {
  return z.object({
    kind: z.literal(kind),
    id: z.string(),
    turnId: z.string().optional(),
    title: z.string().optional(),
    toolKind: acpToolKindSchema.optional(),
    status: acpToolCallStatusSchema.optional(),
    diff: acpDiffSchema.optional(),
    rawInput: z.unknown().optional(),
    content: z.unknown().optional(),
    parentToolCallId: z.string().optional(),
    locations: z.unknown().optional(),
  });
}

/** `AcpToolCallUpdate` — shared by `AcpTranscriptUpdate`'s two tool-call kinds below and the permission-request payload's `toolCall`. `id` is required (issue #548's root cause: it was declared `string` but never actually checked). */
export const acpToolCallUpdateSchema = z.discriminatedUnion('kind', [
  acpToolCallVariantSchema('tool_call'),
  acpToolCallVariantSchema('tool_call_update'),
]);

function acpMessageChunkVariantSchema(
  kind: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk',
) {
  return z.object({
    kind: z.literal(kind),
    turnId: z.string(),
    messageId: z.string(),
    text: z.string(),
  });
}

const acpPlanEntrySchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});

const acpPlanUpdateSchema = z.object({
  kind: z.literal('plan_update'),
  entries: z.array(acpPlanEntrySchema),
});

const acpUsageUpdateSchema = z.object({
  kind: z.literal('usage_update'),
  sessionId: z.string(),
  tokensUsed: z.number().optional(),
  contextWindow: z.number().optional(),
  costUsd: z.number().optional(),
});

/** `AcpTranscriptUpdate` (SPEC.md §7.24/§5.5) — the full v1 update surface the transcript reducer consumes, discriminated on `kind`. */
export const acpTranscriptUpdateSchema = z.discriminatedUnion('kind', [
  acpMessageChunkVariantSchema('user_message_chunk'),
  acpMessageChunkVariantSchema('agent_message_chunk'),
  acpMessageChunkVariantSchema('agent_thought_chunk'),
  acpToolCallVariantSchema('tool_call'),
  acpToolCallVariantSchema('tool_call_update'),
  acpPlanUpdateSchema,
  acpUsageUpdateSchema,
]);

const acpPermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});

/**
 * The plaintext a `permission_request` envelope decrypts to (SPEC §7.24;
 * `@loombox/protocol`'s `steering.ts` doc comment: "the permission
 * request's `ToolCallUpdate` ... travel[s] as an opaque `encryptedEnvelope`").
 * Mirrors ACP's own `AcpRequestPermissionParams` minus `sessionId` (already
 * on the envelope's routing fields).
 */
export const acpPermissionRequestPayloadSchema = z.object({
  toolCall: acpToolCallUpdateSchema,
  options: z.array(acpPermissionOptionSchema),
});
