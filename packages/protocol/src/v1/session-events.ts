import { z } from 'zod';

/**
 * The v1 "session lifecycle" signals (SPEC §7.24's status badge/model-mode-
 * effort bar/turn-settling bullets; SPEC §8's relay-blind boundary). Unlike
 * the raw ACP transcript-reducer update kinds (`agent_message_chunk`,
 * `tool_call`, `plan_update`, `usage_update`, ...), which are `@loombox/
 * providers-core`'s to own and this package deliberately never re-declares
 * (`transcript.ts`'s doc comment: "this package does NOT re-declare that
 * union; to the wire and the relay it is opaque ciphertext") — these six
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
 * `'working'` through `'exited'` reuse `@loombox/supervisor`'s already-shipped
 * `AttentionStatus` vocabulary verbatim (`packages/supervisor/src/
 * transcript-store.ts`) rather than inventing a second taxonomy for the
 * same concept — that status is exactly what `AgentSession` already
 * computes and is what `@loombox/node` forwards here unchanged, just now
 * reaching the wire.
 *
 * `'queued'` and `'starting'` (issues #252, #516) are two of the three
 * members with no `AttentionStatus` counterpart, both synthesized by
 * `@loombox/node` rather than passed through from the agent process:
 *
 * - `'starting'` exists for the window between a session's worktree
 *   landing on disk and its agent process actually finishing `AcpClient.
 *   newSession()` — `@loombox/node` announces the session (`session_announce`
 *   plus this status) the moment the worktree exists, before ever calling
 *   `AgentSupervisor.start()`, because that spawn has no ceiling on how long
 *   it can take (a cold `npm exec` registry install was observed sitting for
 *   nine minutes) and the alternative — waiting for the agent before telling
 *   anyone the session exists — is what let a real session's worktree get
 *   created with nothing tracking it anywhere (SPEC §5.6/§7.22's "sessions
 *   survive" is broken worse by a slow spawn than by a disconnect).
 * - `'queued'` (SPEC §7.16's per-target concurrency cap, issue #252) is
 *   earlier still: a session whose target is already at its configured
 *   concurrency cap sits here, worktree created and fully visible on the
 *   board, until a running session on that target finishes/crashes/is
 *   stopped and hands its slot over (FIFO). A session never skips this
 *   state on its way to `'starting'` when it had to wait at all — a client
 *   that cannot distinguish `'queued'` from `'starting'` would show a spinner
 *   for a session that hasn't actually been asked to do anything yet, which
 *   is the whole reason this is its own value rather than reusing
 *   `'starting'` for both.
 * - `'disconnected'` (issue #702) is the wire counterpart of
 *   `@loombox/node`'s own `SessionLifecycleState` value of the same name
 *   (`session-manager.ts`'s doc comment): a session reloaded from a node's
 *   on-disk `sessions.json` after a restart, whose agent process died with
 *   the previous one. Deliberately NOT added to `AcpSessionStatus`
 *   (`@loombox/providers-core`'s five-value union) even though it is a
 *   session-status concept — that union is, by its own doc comment,
 *   "exactly what `AgentSession` already computes," and there is no
 *   `AgentSession` behind a disconnected session at all; `'queued'`/
 *   `'starting'` set the precedent that a node-lifecycle state with no
 *   agent behind it belongs here, protocol-side, not there. Pushed via
 *   `@loombox/node`'s `sendSessionStatus` (usable with no bridge, exactly
 *   like `'starting'`/an aborted-spawn `'error'` already are) on every
 *   reconnect, for every session this node's `SessionManager` reports as
 *   `'disconnected'` — so a client that was offline for the actual
 *   transition still learns the true state the moment it (or its node)
 *   reconnects, not just the client that happened to be subscribed live.
 *
 * All three are enum *widenings*: an older peer's zod validation on this
 * field simply rejects/drops a `session_status` envelope carrying
 * `'queued'`, `'starting'`, or `'disconnected'` (none reaches a value that
 * peer's own schema would have accepted before), degrading to "no status
 * update yet" rather than crashing — acceptable because the very next
 * transition (to `'working'`/`'awaiting_input'`/`'error'`) is a value every
 * peer, old or new, already understands.
 */
export const sessionStatusV1 = z.enum([
  'queued',
  'starting',
  'working',
  'awaiting_input',
  'permission_required',
  'error',
  'exited',
  'disconnected',
]);
export type SessionStatusV1 = z.infer<typeof sessionStatusV1>;

/** A session's current status, pushed whenever it transitions (SPEC §7.13/§7.24's status badge). */
export const sessionStatusEventV1 = z.object({
  kind: z.literal('session_status'),
  status: sessionStatusV1,
  updatedAt: z.string().min(1),
  /**
   * Set only alongside an `'error'` status the node wants the client to
   * show VERBATIM rather than a generic "session failed" — today the one
   * producer is a custom-agent allowlist refusal (issue #748's "a request
   * to run a binary outside it is refused with a reason the client
   * shows"), naming the disallowed command and where the allowlist lives.
   * `undefined` for every other status transition and for an ordinary
   * spawn failure with nothing more specific to add than "error" — this is
   * additive, so an older peer's schema simply drops an unrecognized field
   * rather than rejecting the whole envelope (mirrors `sessionStatusV1`'s
   * own "enum widenings degrade, never crash" doc comment above).
   */
  reason: z.string().optional(),
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
 * ACP's `AvailableCommand.input` sub-shape — `{hint}` is the only variant
 * ACP documents today (mirrors `@loombox/providers-core`'s
 * `AcpAvailableCommandInput`). `.passthrough()`, not plain `z.object()`: a
 * future ACP variant this schema has never seen must still validate rather
 * than being rejected, and any field on it beyond `hint` must still reach
 * the client rather than being silently zod-stripped (issue #741).
 */
export const acpAvailableCommandInputV1 = z.object({ hint: z.string().optional() }).passthrough();
export type AcpAvailableCommandInputV1 = z.infer<typeof acpAvailableCommandInputV1>;

/**
 * One command the connected agent declared (mirrors `@loombox/
 * providers-core`'s `AcpAvailableCommand`; issue #741). `.passthrough()`,
 * not `.strict()`/plain `z.object()`: an ACP `AvailableCommand` field this
 * schema has never seen must still reach the client rather than being
 * silently zod-stripped — the same "never drop what you don't recognize"
 * rule `acpConfigOptionV1`'s open `category` string already carries above,
 * just applied at the object-key level instead of a closed-enum level,
 * since `AvailableCommand` has no analogous closed-set field to leave open.
 */
export const acpAvailableCommandV1 = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    input: acpAvailableCommandInputV1.optional(),
  })
  .passthrough();
export type AcpAvailableCommandV1 = z.infer<typeof acpAvailableCommandV1>;

/**
 * The session's complete, agent-declared command catalogue (SPEC §7.24's
 * slash-command surface; issue #741), pushed as a full wholesale
 * replacement whenever the agent (re)declares it. Unlike
 * `configOptionsEventV1`/`configOptionUpdateEventV1` above there is only
 * one `kind` here, not two: ACP's `available_commands_update` has no
 * `session/new`-seeded counterpart to distinguish a first push from a
 * later unprompted one — a real agent only ever sends this as a
 * notification, verified directly against a real `omp acp` binary — so
 * there is nothing for a second kind to distinguish.
 */
export const availableCommandsUpdateEventV1 = z.object({
  kind: z.literal('available_commands_update'),
  commands: z.array(acpAvailableCommandV1),
});
export type AvailableCommandsUpdateEventV1 = z.infer<typeof availableCommandsUpdateEventV1>;

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
  availableCommandsUpdateEventV1,
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
