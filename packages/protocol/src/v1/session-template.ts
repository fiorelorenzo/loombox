import { z } from 'zod';
import { customAgentRecordV1 } from './custom-agent';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Wire surface for `@loombox/node`'s named session-template catalog (issue
 * #259, epic #29): a one-click way to repeat a "new session" workflow.
 *
 * Read against `NewSessionDialog.svelte` and #752's agent-profile catalog
 * before this shipped, on purpose (see that dialog's own doc comment for
 * the full history): a template is deliberately NOT a bigger thing than
 * the dialog itself asks for today. Concretely, it captures exactly the
 * dialog's own per-session choices —
 * `targetId` (which of this account's targets/projects it applies to),
 * `provider`/`customAgent` (the agent picker), `worktree` (the Workspace
 * radio, only meaningful for a git repo), and `title` (a default the user
 * can still edit before creating) — and nothing past that:
 * - No MCP server set: the dialog does not let a user CHOOSE one per
 *   session at all. It always forwards whatever the project's Config
 *   panel currently has enabled (`apps/web`'s `mcp-server-store.ts`), so a
 *   template applying that same project would already get the same
 *   servers with zero extra fields — capturing it here would be a second,
 *   driftable copy of a value the project's own store already owns.
 * - No starting prompt: issue #761 removed that field from the dialog
 *   entirely. A session is always created empty; the first message goes
 *   through the composer afterwards.
 * - No agent-profile deny rules (issue #752's `AgentProfileV1` —
 *   `deniedToolKinds`/`deniedToolNamePatterns`/`deniedMcpServers`): the
 *   dialog has no profile picker yet, so a template has nothing to record
 *   there either. If/when one is added, the right shape is a `profileId`
 *   REFERENCE into that catalog, never a duplicated copy of its fields —
 *   exactly the "compose, don't duplicate" rule #752 itself follows for
 *   `sessionPrivateMetaV1.profileId`.
 *
 * Stored per account (`@loombox/node`'s `session-template-store.ts`), one
 * JSON file, mirroring `agent-profile-store.ts`'s own shape and rationale:
 * small, changes rarely, every mutation re-reads then rewrites the whole
 * file. Routed by `nodeId`+`targetId` directly, NOT by an existing
 * session's `sessionId` the way `agent-profile.ts`'s own catalog pair is:
 * `NewSessionDialog` is, definitionally, the one place in this app that
 * opens for a project with NO session created yet (a repeated workflow's
 * very first run has nothing to route through) — the same "no session (and
 * often no project) yet" case `target-fs.ts`/`custom-agent.ts`'s own
 * `nodeId`+`targetId`-keyed request pairs already solve, and for the
 * identical reason. `project.nodeId`/`project.targetId` are exactly what
 * `NewSessionDialog` already has in hand (see its own `probeCustomAgent`
 * call), so this never needs a live session to exist first.
 *
 * `session_template_list_get`/`_set` carry no session-private content of
 * their own (`_get` is a bare ask, `_set`'s envelope is a full
 * `SessionTemplateV1[]` replace) and reply with the same
 * `session_template_list_result`, mirroring `agent_profile_list_get/_set`'s
 * shared-reply convention. The `_set` request and the result are both
 * envelope-sealed under the same per-target key `target_fs_list_request`/
 * `custom_agent_probe_request` already use (`deriveTargetKey`) — a
 * template's name and agent choice are project-adjacent-but-not-quite
 * conversation content, sealed for the same "opaque to the relay" reason,
 * never a carved-out plaintext exception.
 */

/** One saved session template. */
export const sessionTemplateV1 = z.object({
  id: z.string().min(1),
  /** The template's own display name (distinct from `title`, the session's own default title). */
  name: z.string().min(1),
  /** Which target this template applies to (`Project.targetId`) — a client filters the picker to templates whose `targetId` matches the project currently open, exactly like the dialog's own Agent field only ever lists that target's real providers. */
  targetId: z.string().min(1),
  /** The provider id, or the `'custom'` sentinel when `customAgent` is set — mirrors `CreateSessionOptions.provider`'s own convention exactly. */
  provider: z.string().min(1),
  /** Present only when `provider` is `'custom'` — the full custom-agent record, so applying this template never depends on that agent already existing in the target project's own per-project custom-agent list. */
  customAgent: customAgentRecordV1.optional(),
  /** SPEC §7.1's per-session Workspace choice — omitted for a template saved against a non-git-repo project, exactly like `CreateSessionOptions.worktree` itself is omitted in that case. */
  worktree: z.boolean().optional(),
  /** A default session title this template prefills — still just a starting point, editable before creating, exactly like typing it by hand would be. */
  title: z.string().optional(),
});
export type SessionTemplateV1 = z.infer<typeof sessionTemplateV1>;

/** The plaintext a `session_template_list_result` envelope decrypts to. */
export const sessionTemplateListResultPayloadV1 = z.object({
  templates: z.array(sessionTemplateV1),
});
export type SessionTemplateListResultPayloadV1 = z.infer<typeof sessionTemplateListResultPayloadV1>;

/** The plaintext a `session_template_list_set` envelope decrypts to. */
export const sessionTemplateListSetPayloadV1 = z.object({
  templates: z.array(sessionTemplateV1),
});
export type SessionTemplateListSetPayloadV1 = z.infer<typeof sessionTemplateListSetPayloadV1>;

/** Parses and validates a decrypted `session_template_list_result` payload, throwing on an invalid one. */
export function parseSessionTemplateListResultPayloadV1(
  data: unknown,
): SessionTemplateListResultPayloadV1 {
  return sessionTemplateListResultPayloadV1.parse(data);
}

/** Same as {@link parseSessionTemplateListResultPayloadV1} but never throws; returns zod's result. */
export function safeParseSessionTemplateListResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SessionTemplateListResultPayloadV1> {
  return sessionTemplateListResultPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `session_template_list_set` payload, throwing on an invalid one. */
export function parseSessionTemplateListSetPayloadV1(
  data: unknown,
): SessionTemplateListSetPayloadV1 {
  return sessionTemplateListSetPayloadV1.parse(data);
}

/** Same as {@link parseSessionTemplateListSetPayloadV1} but never throws; returns zod's result. */
export function safeParseSessionTemplateListSetPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SessionTemplateListSetPayloadV1> {
  return sessionTemplateListSetPayloadV1.safeParse(data);
}

/** A client asks the owning node (identified directly by `nodeId`+`targetId` — see this file's doc comment) for its account's saved session-template catalog. No envelope on the request: nothing about "which node/target is this" is worth hiding, same reasoning `target_fs_list_request`'s own doc comment documents for browsing before a session exists. */
export const sessionTemplateListGet = z.object({
  type: z.literal('session_template_list_get'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  requestId: z.string().min(1),
});
export type SessionTemplateListGet = z.infer<typeof sessionTemplateListGet>;

/** A client asks the owning node to save (fully replace) its account's session-template catalog. */
export const sessionTemplateListSet = z.object({
  type: z.literal('session_template_list_set'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type SessionTemplateListSet = z.infer<typeof sessionTemplateListSet>;

/** The owning node's reply to `session_template_list_get`/`_set` — the account's current saved catalog. `targetId` rides along so the relay can deliver it back to the requesting client without a session to fan it through, mirroring `target_fs_list_response`. */
export const sessionTemplateListResult = z.object({
  type: z.literal('session_template_list_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  targetId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type SessionTemplateListResult = z.infer<typeof sessionTemplateListResult>;
