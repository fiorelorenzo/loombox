import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * A per-project custom ACP agent, defined client-side (SPEC's Zed-parity
 * decision D1-3, `docs/superpowers/specs/2026-08-05-zed-parity-decisions.md`
 * §4; issue #748). Structurally identical to `@loombox/providers-core`'s
 * `AcpSpawnConfig` (`command`/`args`/`env`) plus the two optional per-agent
 * defaults the issue names, so a client never has to hand-translate between
 * "what the user typed" and "what a provider module's spawn recipe looks
 * like" — `packages/node`'s `createCustomAgentProvider` builds an
 * `AcpSpawnConfig` from this record verbatim.
 *
 * **This record is convenience only — it is NOT the security boundary.**
 * D1-3's trust model (inherited from D1-2) is explicit that the record
 * travels from an untrusted client to the node, and the node alone decides
 * whether `command` may actually run, against its own local allowlist
 * (`@loombox/node`'s `config.ts` — `customAgentAllowlist`, file/env-only,
 * never settable over this wire). A record naming a disallowed `command`
 * still parses cleanly here; it is refused later, at spawn time, with a
 * reason naming the allowlist (`NodeDaemon`'s `CustomAgentNotAllowedError`).
 *
 * Carried inside `sessionPrivateMetaV1.customAgent` (`sessions.ts`), so it
 * travels exactly like `title`/`projectPath` already do: sealed into
 * `session_create`'s `privateEnvelope`, opaque to the relay, opened by the
 * owning node under the session's derived key (SPEC §8) — "encrypted like
 * everything else" per the issue.
 */
export const customAgentRecordV1 = z.object({
  /** Human-readable label the picker/session context line shows (e.g. "My internal agent"). Distinct from `command`: a project may define several custom agents that all spawn the same binary with different args/env. */
  name: z.string().min(1),
  /** The binary to spawn — checked against the node's own allowlist before it is ever run (see this schema's own doc comment). Matched verbatim, never resolved/canonicalized client-side: the node decides what "the same command" means. */
  command: z.string().min(1),
  /** Args passed to `command`, in order. `[]` (not `undefined`) once parsed, so a caller never has to null-check before spreading into a spawn recipe. */
  args: z.array(z.string()).default([]),
  /** Extra environment variables merged into the spawned process's env (mirrors `AcpSpawnConfig.env`). `undefined` — never `{}` — when the user set none, so a caller can tell "no overrides" from "explicitly emptied". */
  env: z.record(z.string(), z.string()).optional(),
  /**
   * The ACP `mode` config-option choice id (SPEC §7.24's `configOptions`
   * `'mode'` category) to select right after this session's agent process
   * reports its initial config-option catalog — e.g. a custom agent whose
   * default mode is verbose/read-only should not require a manual switch
   * every single session. Applied best-effort (`NodeDaemon.
   * applyCustomAgentDefaults`): an agent that rejects the id (unknown to
   * its own catalog) logs a warning and leaves the session's default mode
   * in place, never fails the session.
   */
  defaultMode: z.string().min(1).optional(),
  /**
   * Additional config-option defaults beyond `mode`, keyed by the
   * catalog's own `category` (e.g. `{ model: 'anthropic/claude-opus-5' }`)
   * — same best-effort application as `defaultMode`, one `session/
   * set_config_option` call per entry.
   */
  defaultConfigOptions: z.record(z.string(), z.string()).optional(),
});
export type CustomAgentRecordV1 = z.infer<typeof customAgentRecordV1>;

/**
 * The custom-agent counterpart of `target-fs.ts`'s `target_fs_list_request`
 * pair (issue #748's provider-availability-probing bullet: "the way
 * registered providers are probed today", `@loombox/node`'s
 * `probeProviderAvailability`, just for one caller-named command instead of
 * this node's fixed candidate list). Lets a client check, BEFORE ever
 * attempting to create a session, whether a custom agent's `command` is
 * both installed on a target's PATH (`available`) and permitted to run
 * there at all (`allowed`, this node's allowlist) — so a form can show
 * "not installed" separately from "blocked by this node's operator" rather
 * than a session simply failing later with one undifferentiated error.
 *
 * Keyed by `nodeId` + `targetId` directly, exactly like
 * `target_fs_list_request`: there is no session (and often no project) yet
 * to resolve a routing key through. `command` alone travels inside the
 * envelope, sealed under the same per-target key `target_fs_list_request`
 * uses (`deriveTargetKey`) — routing metadata (`nodeId`/`targetId`/
 * `requestId`) stays clear, same boundary as every other target-scoped
 * request in this package.
 */
export const customAgentProbeRequestPayloadV1 = z.object({
  command: z.string().min(1),
});
export type CustomAgentProbeRequestPayloadV1 = z.infer<typeof customAgentProbeRequestPayloadV1>;

/** Parses and validates a decrypted `custom_agent_probe_request` payload, throwing on an invalid one. */
export function parseCustomAgentProbeRequestPayloadV1(
  data: unknown,
): CustomAgentProbeRequestPayloadV1 {
  return customAgentProbeRequestPayloadV1.parse(data);
}

/** Same as {@link parseCustomAgentProbeRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseCustomAgentProbeRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, CustomAgentProbeRequestPayloadV1> {
  return customAgentProbeRequestPayloadV1.safeParse(data);
}

/**
 * The successful outcome: `available` is this node's own PATH probe on the
 * named target (identical mechanism to a registered provider's
 * `requiredCommand` check); `allowed` is this node's local allowlist
 * verdict. Both are reported — a command can be installed but not
 * allowlisted, or allowlisted but not installed on this particular target
 * — so the client can show the real reason rather than a single boolean.
 */
export const customAgentProbeResultV1 = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ok'), available: z.boolean(), allowed: z.boolean() }),
  z.object({ outcome: z.literal('error'), message: z.string().min(1) }),
]);
export type CustomAgentProbeResultV1 = z.infer<typeof customAgentProbeResultV1>;

export const customAgentProbeResponsePayloadV1 = z.object({
  result: customAgentProbeResultV1,
});
export type CustomAgentProbeResponsePayloadV1 = z.infer<typeof customAgentProbeResponsePayloadV1>;

/** Parses and validates a decrypted `custom_agent_probe_response` payload, throwing on an invalid one. */
export function parseCustomAgentProbeResponsePayloadV1(
  data: unknown,
): CustomAgentProbeResponsePayloadV1 {
  return customAgentProbeResponsePayloadV1.parse(data);
}

/** Same as {@link parseCustomAgentProbeResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseCustomAgentProbeResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, CustomAgentProbeResponsePayloadV1> {
  return customAgentProbeResponsePayloadV1.safeParse(data);
}

export const customAgentProbeRequest = z.object({
  type: z.literal('custom_agent_probe_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type CustomAgentProbeRequest = z.infer<typeof customAgentProbeRequest>;

/** The node's reply, delivered back to the requesting client only — the relay matches it to its pending `custom_agent_probe_request` by `requestId`, exactly like `target_fs_list_response`. */
export const customAgentProbeResponse = z.object({
  type: z.literal('custom_agent_probe_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  targetId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type CustomAgentProbeResponse = z.infer<typeof customAgentProbeResponse>;
