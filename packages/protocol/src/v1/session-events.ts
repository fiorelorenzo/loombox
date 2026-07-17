import { z } from 'zod';

/**
 * The v1 "session lifecycle" signals (SPEC §7.24's status badge/model-mode-
 * effort bar/turn-settling bullets; SPEC §8's relay-blind boundary). Unlike
 * the raw ACP transcript-reducer update kinds (`agent_message_chunk`,
 * `tool_call`, `plan_update`, `usage_update`, ...), which are `@loombox/
 * providers-core`'s to own and this package deliberately never re-declares
 * (`transcript.ts`'s doc comment: "this package does NOT re-declare that
 * union; to the wire and the relay it is opaque ciphertext") — these five
 * kinds are loombox's OWN invention layered on top of ACP, synthesized by
 * the node from the supervisor's `AgentSession` attention/turn-lifecycle
 * state, not raw passthrough of anything the agent process itself sends. So
 * it is this package's job to be their one validated source of truth.
 *
 * They still never become a new top-level `WireMessageV1` member and the
 * relay is never told about them: exactly like every other transcript
 * update, a value here is JSON-serialized and sealed (`@loombox/crypto`'s
 * `sealJson`) into the *existing* `session_update` envelope
 * (`transcript.ts`'s `sessionUpdateEnvelopeV1`) by `@loombox/node`, and
 * opened back out client-side — the relay only ever forwards/stores the
 * resulting ciphertext, identical to a transcript chunk. `@loombox/
 * providers-core`'s reducer mirrors this same shape field-for-field as a
 * plain TS union (`AcpSessionLifecycleEvent` in `transcript.ts`) rather than
 * importing it from here, the same mirrored-not-shared pattern already used
 * across the encryption boundary elsewhere in this codebase (e.g. `apps/
 * web`'s `relay-client.ts` mirrors `@loombox/node`'s `SessionPrivateMeta`/
 * `PromptPayload` rather than importing them) — `@loombox/providers-core`
 * has zero workspace dependencies by design (SPEC §10.1's layered-ACP
 * packages), and this package must stay one-directional (no dependency on
 * `@loombox/providers-core`) so neither side's build graph gains a cycle.
 */

/** One ACP config-option choice (mirrors `@loombox/providers-core`'s `AcpConfigOptionChoice`). */
export const acpConfigOptionChoiceV1 = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type AcpConfigOptionChoiceV1 = z.infer<typeof acpConfigOptionChoiceV1>;

/**
 * One ACP config-option category (mirrors `@loombox/providers-core`'s
 * `AcpConfigOption`). `category` is deliberately an open string, not a
 * closed enum: SPEC §7.24 requires an unrecognized/future category to still
 * render generically rather than being dropped, so this schema must not
 * reject one.
 */
export const acpConfigOptionV1 = z.object({
  category: z.string().min(1),
  current: z.string().optional(),
  choices: z.array(acpConfigOptionChoiceV1),
});
export type AcpConfigOptionV1 = z.infer<typeof acpConfigOptionV1>;

/**
 * The session-status vocabulary (SPEC §7.13/§5.6's attention-worthy states).
 * Deliberately reuses `@loombox/supervisor`'s already-shipped `AttentionStatus`
 * vocabulary verbatim (`packages/supervisor/src/transcript-store.ts`) rather
 * than inventing a second taxonomy for the same concept — that status is
 * exactly what `AgentSession` already computes and is what `@loombox/node`
 * forwards here unchanged, just now reaching the wire.
 */
export const sessionStatusV1 = z.enum([
  'working',
  'awaiting_input',
  'permission_required',
  'error',
  'exited',
]);
export type SessionStatusV1 = z.infer<typeof sessionStatusV1>;

/** A session's current status, pushed whenever it transitions (SPEC §7.13/§7.24's status badge). */
export const sessionStatusEventV1 = z.object({
  kind: z.literal('session_status'),
  status: sessionStatusV1,
  updatedAt: z.string().min(1),
});
export type SessionStatusEventV1 = z.infer<typeof sessionStatusEventV1>;

/**
 * The session's complete, negotiated config-option catalog (SPEC §7.24
 * "Model, mode & reasoning effort"), pushed as a full wholesale replacement
 * — never a per-category patch — whenever it is (re)seeded: on session
 * creation/resume, or after this client's own `config_option` selection is
 * acknowledged. `config_option_update` below is the same shape for the
 * distinct *unprompted* case (issue #149).
 */
export const configOptionsEventV1 = z.object({
  kind: z.literal('config_options'),
  options: z.array(acpConfigOptionV1),
});
export type ConfigOptionsEventV1 = z.infer<typeof configOptionsEventV1>;

/**
 * An unprompted config-option change (SPEC §7.24: "e.g. an automatic
 * fallback to a cheaper model after a rate limit") — the agent changed its
 * own config without the user asking. Same payload shape as
 * `config_options` above; kept as its own `kind` (rather than a boolean
 * flag) so a client can route it to the attention inbox (SPEC §7.13)
 * without inspecting a second field, and so an older client that only knows
 * `config_options` still degrades safely (an unrecognized `kind` is simply
 * ignored, per this union's additive/version-safe design).
 */
export const configOptionUpdateEventV1 = z.object({
  kind: z.literal('config_option_update'),
  options: z.array(acpConfigOptionV1),
});
export type ConfigOptionUpdateEventV1 = z.infer<typeof configOptionUpdateEventV1>;

/**
 * A new turn began (SPEC §7.24's turn-lifecycle bullet) — sent by the node
 * right before it hands a prompt to the agent's `session/prompt`, regardless
 * of which device's composer originated it, so every subscribed client
 * (including one that didn't send the prompt) can flip its own "turn in
 * flight" state deterministically instead of inferring it from output
 * arriving.
 */
export const turnStartedEventV1 = z.object({
  kind: z.literal('turn_started'),
  turnId: z.string().min(1),
});
export type TurnStartedEventV1 = z.infer<typeof turnStartedEventV1>;

/**
 * A turn settled (SPEC §7.24; issue #128's idle-timeout gap) — `stopReason`
 * carries ACP's own `session/prompt` response field verbatim (e.g.
 * `end_turn`, `max_tokens`, `refusal`) when the agent supplied one. This is
 * the deterministic signal a client uses to flush its next queued prompt
 * instead of guessing from an idle-quiet heuristic.
 */
export const turnEndedEventV1 = z.object({
  kind: z.literal('turn_ended'),
  turnId: z.string().optional(),
  stopReason: z.string().optional(),
});
export type TurnEndedEventV1 = z.infer<typeof turnEndedEventV1>;

/** The full set of session-lifecycle payloads that can ride inside one `session_update` envelope's plaintext, discriminated on `kind`. */
export const sessionLifecycleEventV1 = z.discriminatedUnion('kind', [
  sessionStatusEventV1,
  configOptionsEventV1,
  configOptionUpdateEventV1,
  turnStartedEventV1,
  turnEndedEventV1,
]);
export type SessionLifecycleEventV1 = z.infer<typeof sessionLifecycleEventV1>;

/** Parses and validates a decrypted session-lifecycle event payload, throwing on an invalid one. */
export function parseSessionLifecycleEventV1(data: unknown): SessionLifecycleEventV1 {
  return sessionLifecycleEventV1.parse(data);
}

/** Same as {@link parseSessionLifecycleEventV1} but never throws; returns zod's result. */
export function safeParseSessionLifecycleEventV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SessionLifecycleEventV1> {
  return sessionLifecycleEventV1.safeParse(data);
}
