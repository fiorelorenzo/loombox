import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Wire surface for `@loombox/node`'s named agent-profile catalog (design
 * spec `2026-08-05-zed-parity-decisions.md`'s D3-4, "profiles" half; issue
 * #752 — the sibling of `permission-policy.ts`'s "rules" half, issue #751).
 * `@loombox/node`'s `agent-profile.ts` owns the actual filter semantics
 * (ACP tool-kind/tool-name deny rules, MCP-server-at-spawn omission — see
 * that module's own doc comment for why a profile here cannot be Zed's
 * closed per-tool boolean map); this file only carries the same shape
 * across the wire. Like that module, this package stays entirely ignorant
 * of ACP's own vocabulary (no `AcpToolKind` enum here — see `transcript.ts`'s
 * doc comment for why `@loombox/protocol` never re-declares ACP shapes):
 * `deniedToolKinds` is validated here only as a non-empty-string array,
 * the same "opaque past the structural check" contract
 * `agent-profile-store.ts` already applies node-side for the identical
 * "quiet degrade, never a validation error" reason issue #752 requires.
 *
 * Two catalog request/reply pairs plus one per-session request/reply pair,
 * following `permission-policy.ts`'s own precedent (itself following
 * `tracker.ts`/`test-runner-config.ts`) rather than inventing a fourth
 * wire convention:
 * - `agent_profile_list_get` / `agent_profile_list_result` — read the
 *   full saved catalog (`[]` for a node with nothing saved yet, mirroring
 *   `AgentProfileStore.list()`'s own default). No envelope on the request
 *   — same "nothing to hide about which session is asking" reasoning
 *   `permission_policy_get` already documents.
 * - `agent_profile_list_set` / `agent_profile_list_result` — save the
 *   whole catalog (never a partial patch — mirrors
 *   `AgentProfileStore.saveAll()`'s own "creates or replaces... in full"
 *   contract). Reuses the same `agent_profile_list_result` reply as
 *   `_get`.
 * - `agent_profile_session_get` / `agent_profile_session_result` — read
 *   which profile (`profileId`, `null` for "none active" — unrestricted)
 *   is currently active for one session.
 * - `agent_profile_session_set` / `agent_profile_session_result` —
 *   switch a session's active profile. Applies starting with the very
 *   next `session/request_permission` call, never retroactively and
 *   never half-applied (issue #752's own decision, documented in
 *   `@loombox/node`'s `agent-profile.ts`'s `evaluateAgentProfile` doc
 *   comment — the resolver reading it is called fresh on every request,
 *   the same "never cached" contract `policy-enforced-pty.ts`'s policy
 *   resolver already established for #751's mid-session rule edits).
 *   Answered with `outcome: 'error'` when the session has no live agent
 *   process to apply this to (mirrors `config_option`'s own "disconnected
 *   since the last restart" case) rather than silently accepted.
 *
 * Both catalog messages are envelope-sealed on `_set` (a profile's own
 * deny rules are project-adjacent-but-not-quite conversation content —
 * sealed for the same "opaque to the relay" reason `permission_policy_set`
 * already is) and the session-scoped pair is envelope-sealed on `_set`
 * too, even though `profileId` alone is a low-sensitivity reference: it
 * still names which of an account's named profiles (each carrying a
 * human-chosen `name`) is active, so it gets the same treatment as every
 * other session-routed mutation rather than a carved-out plaintext
 * exception.
 *
 * Addressed by `sessionId` (the node resolves the owning account itself;
 * there is no `projectPath` here at all — a profile catalog is
 * account-scoped, not per-project) exactly like `permission_policy_get`'s
 * own doc comment documents for that message's `sessionId` addressing.
 */

/** A single denied entry — trimmed and rejected if blank, same "no unsatisfiable-by-construction blank rule" discipline `permission-policy.ts`'s own `globPattern` already applies. */
const deniedEntry = z.string().trim().min(1, 'a denied entry cannot be blank');

/** One named agent profile — mirrors `@loombox/node`'s `AgentProfile`. */
export const agentProfileV1 = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  deniedToolKinds: z.array(deniedEntry),
  deniedToolNamePatterns: z.array(deniedEntry),
  deniedMcpServers: z.array(deniedEntry),
});
export type AgentProfileV1 = z.infer<typeof agentProfileV1>;

/** The plaintext an `agent_profile_list_result` envelope decrypts to. */
export const agentProfileListResultPayloadV1 = z.object({
  profiles: z.array(agentProfileV1),
});
export type AgentProfileListResultPayloadV1 = z.infer<typeof agentProfileListResultPayloadV1>;

/** The plaintext an `agent_profile_list_set` envelope decrypts to. */
export const agentProfileListSetPayloadV1 = z.object({
  profiles: z.array(agentProfileV1),
});
export type AgentProfileListSetPayloadV1 = z.infer<typeof agentProfileListSetPayloadV1>;

/** Parses and validates a decrypted `agent_profile_list_result` payload, throwing on an invalid one. */
export function parseAgentProfileListResultPayloadV1(
  data: unknown,
): AgentProfileListResultPayloadV1 {
  return agentProfileListResultPayloadV1.parse(data);
}

/** Same as {@link parseAgentProfileListResultPayloadV1} but never throws; returns zod's result. */
export function safeParseAgentProfileListResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, AgentProfileListResultPayloadV1> {
  return agentProfileListResultPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `agent_profile_list_set` payload, throwing on an invalid one. */
export function parseAgentProfileListSetPayloadV1(data: unknown): AgentProfileListSetPayloadV1 {
  return agentProfileListSetPayloadV1.parse(data);
}

/** Same as {@link parseAgentProfileListSetPayloadV1} but never throws; returns zod's result. */
export function safeParseAgentProfileListSetPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, AgentProfileListSetPayloadV1> {
  return agentProfileListSetPayloadV1.safeParse(data);
}

/** A client asks the owning node for its account's saved agent-profile catalog. No envelope — see this file's doc comment. */
export const agentProfileListGet = z.object({
  type: z.literal('agent_profile_list_get'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type AgentProfileListGet = z.infer<typeof agentProfileListGet>;

/** A client asks the owning node to save (fully replace) its account's agent-profile catalog. */
export const agentProfileListSet = z.object({
  type: z.literal('agent_profile_list_set'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type AgentProfileListSet = z.infer<typeof agentProfileListSet>;

/** The owning node's reply to `agent_profile_list_get`/`agent_profile_list_set` — the account's current saved catalog. */
export const agentProfileListResult = z.object({
  type: z.literal('agent_profile_list_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type AgentProfileListResult = z.infer<typeof agentProfileListResult>;

/** The plaintext an `agent_profile_session_result`/`agent_profile_session_set` envelope decrypts to — `null` means no profile is active (unrestricted). */
export const agentProfileSessionPayloadV1 = z.object({
  profileId: z.string().min(1).nullable(),
});
export type AgentProfileSessionPayloadV1 = z.infer<typeof agentProfileSessionPayloadV1>;

/** Parses and validates a decrypted `agent_profile_session_result`/`_set` payload, throwing on an invalid one. */
export function parseAgentProfileSessionPayloadV1(data: unknown): AgentProfileSessionPayloadV1 {
  return agentProfileSessionPayloadV1.parse(data);
}

/** Same as {@link parseAgentProfileSessionPayloadV1} but never throws; returns zod's result. */
export function safeParseAgentProfileSessionPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, AgentProfileSessionPayloadV1> {
  return agentProfileSessionPayloadV1.safeParse(data);
}

/** A client asks the owning node which profile is currently active for a session. No envelope. */
export const agentProfileSessionGet = z.object({
  type: z.literal('agent_profile_session_get'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type AgentProfileSessionGet = z.infer<typeof agentProfileSessionGet>;

/** A client asks the owning node to switch a session's active profile (`profileId: null` clears it back to unrestricted). Applies starting with the next tool call — see this file's doc comment. */
export const agentProfileSessionSet = z.object({
  type: z.literal('agent_profile_session_set'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type AgentProfileSessionSet = z.infer<typeof agentProfileSessionSet>;

/** The owning node's reply to `agent_profile_session_get`/`agent_profile_session_set` — the session's current active profile id, or an error when there is no live agent to apply a `_set` to. */
export const agentProfileSessionResult = z.object({
  type: z.literal('agent_profile_session_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type AgentProfileSessionResult = z.infer<typeof agentProfileSessionResult>;

/** The plaintext an `agent_profile_session_result` envelope decrypts to when the `_set` it answers could not be applied — e.g. no live agent (mirrors `ConfigOptionSetResult`'s own `{outcome:'error', message}` shape). */
export const agentProfileSessionErrorPayloadV1 = z.object({
  outcome: z.literal('error'),
  message: z.string(),
});
export type AgentProfileSessionErrorPayloadV1 = z.infer<typeof agentProfileSessionErrorPayloadV1>;
