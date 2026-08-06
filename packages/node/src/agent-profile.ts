import type { AcpToolKind } from '@loombox/providers-core';
import { matchAnchoredGlob } from './permission-policy';

/**
 * Named tool-existence profiles that gate which tools a session may use at
 * all (SPEC-adjacent design spec `2026-08-05-zed-parity-decisions.md`'s
 * D3-4, "profiles" half; issue #752 — the sibling of #751's glob policy,
 * which gates *approval mode* for a tool that already exists, not whether
 * it exists in the first place; see that module's own doc comment for the
 * three-layer split this module is one layer of).
 *
 * **Zed's shape does not fit here.** Zed ships three built-in profiles
 * (Write/Ask/Minimal), each a complete `Record<toolName, boolean>` over a
 * *closed* tool catalog Zed itself defines, because Zed's own agent
 * implementation is the one deciding what tools exist. Here the agent
 * (Claude Code, Codex, a generic ACP binary, MCP servers it connects to
 * directly) owns its own tool list — loombox never gets an upfront
 * manifest of every tool an agent might call (`available_commands_update`
 * is a *slash-command* catalog, a completely different ACP concept; a real
 * tool call only self-identifies at the moment it happens, via
 * `session/request_permission`'s `toolCall.title`/`toolCall.kind`). So a
 * profile here cannot be "the definition of every tool, on or off" — it is
 * a **filter over whatever the connected agent actually declares**,
 * expressed the only two ways loombox can reliably recognize a tool ahead
 * of ever seeing it called:
 *
 * - {@link AgentProfile.deniedToolKinds} — ACP's own small, fixed
 *   `AcpToolKind` taxonomy (`read`/`edit`/`delete`/`move`/`search`/
 *   `execute`/`think`/`fetch`/`other`), the one categorization every
 *   correctly-speaking ACP agent already volunteers per call. This is the
 *   closest equivalent to Zed's per-tool boolean map this protocol can
 *   offer without inventing a tool catalog loombox doesn't actually own.
 *   A tool call that arrives with no `toolKind` at all can never match a
 *   kind rule — it is not silently promoted to `'other'`, since that would
 *   be a guess this module has no basis for (see {@link evaluateAgentProfile}).
 * - {@link AgentProfile.deniedToolNamePatterns} — anchored globs (the exact
 *   `*`/`?` dependency-free language `permission-policy.ts` already
 *   defines, reused via {@link matchAnchoredGlob} rather than a second
 *   pattern dialect) matched full-string against a tool call's own
 *   `title`. This is the escape hatch for anything `toolKind` is too
 *   coarse for — disabling one specific tool (`"Bash"`) while its kind
 *   (`execute`) stays otherwise enabled, or one MCP server's tools by
 *   their provider-specific naming convention (Claude Code's own
 *   `mcp__<server>__<tool>` title prefix, for example — `"mcp__github__*"`).
 *   `title` is free text the *provider*, not ACP itself, controls, so this
 *   is deliberately best-effort: a pattern that never matches this agent's
 *   actual titles degrades quietly (see below), never errors.
 *
 * A third field, {@link AgentProfile.deniedMcpServers}, is not a
 * request-time filter at all: it is the one place this feature can offer
 * a *real* "the tool does not exist" guarantee, because MCP server names
 * ARE known ahead of time (`McpConfigStore`'s own `config.name`) and
 * loombox fully controls what it hands the agent at `session/new` — see
 * {@link filterMcpServersForProfile}, applied once at session start rather
 * than per call.
 *
 * **Quiet degrade, never an error** (issue #752's own acceptance): a
 * profile is edited independently of any one session's connected agent —
 * there is no way to validate "does this agent even have a tool by this
 * name/kind" up front, and there does not need to be. A `deniedToolKinds`
 * entry that names a kind this agent's tools never carry, a
 * `deniedToolNamePatterns` glob that never matches any title this agent
 * actually produces, or a `deniedMcpServers` name this account has no
 * server configured under, all simply never match anything — the same
 * "no-op, not a failure" contract `permission-policy.ts`'s own glob rules
 * already have for a pattern that never matches a real command.
 *
 * An empty profile (`[]`/`[]`/`[]`) denies nothing — full access, the
 * "Write"-equivalent default a freshly created profile starts as. There is
 * deliberately no `allow` list on any of these three fields (contrast
 * `permission-policy.ts`'s `PermissionRuleSet`, which needs one to express
 * a strict security allowlist over an open-ended command-string space): a
 * profile only ever *trims* what the agent already declared (D3-4's own
 * "profiles gate existence" framing), and `AcpToolKind`'s universe is
 * small and fixed enough that an "only these kinds" profile is just "deny
 * the other N kinds" — no allow-list-mode auto-expansion needed.
 */
export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  /** ACP tool-kind categories this profile disables outright. */
  readonly deniedToolKinds: readonly AcpToolKind[];
  /** Anchored glob patterns matched full-string against a tool call's own `title`. */
  readonly deniedToolNamePatterns: readonly string[];
  /** MCP server names (exact match against `McpServerConfig.name`) this profile omits from a session's `mcpServers` at spawn time. */
  readonly deniedMcpServers: readonly string[];
}

/** Why {@link evaluateAgentProfile} refused a tool call — carries enough to build both the log line and `@loombox/protocol`'s `ToolRefusalReasonV1`'s `kind: 'profile'` member, without either side needing to know about the other. */
export type ProfileToolDenial =
  | { readonly matchedBy: 'tool-kind'; readonly toolKind: AcpToolKind }
  | { readonly matchedBy: 'tool-name'; readonly rule: string; readonly matched: string };

/**
 * The one enforcement chokepoint this module offers for a live tool call
 * (the request-time half of D3-4's "applied ... as an enforcement point on
 * each tool call") — called fresh on every `session/request_permission`,
 * never cached, so switching a session's active profile mid-session
 * applies starting with the very next call (mirrors `policy-enforced-
 * pty.ts`'s own `() => PermissionPolicy` resolver, read fresh on every
 * submitted line, for the identical "never half-applied" reason).
 * `profile: undefined` (no profile active for this session) always
 * returns `undefined` — every tool proceeds to the normal FIFO queue,
 * unrestricted, matching a session with no policy configured at all.
 */
export function evaluateAgentProfile(
  profile: AgentProfile | undefined,
  toolCall: { readonly toolKind?: AcpToolKind; readonly title?: string },
): ProfileToolDenial | undefined {
  if (!profile) return undefined;

  if (toolCall.toolKind && profile.deniedToolKinds.includes(toolCall.toolKind)) {
    return { matchedBy: 'tool-kind', toolKind: toolCall.toolKind };
  }

  if (toolCall.title) {
    for (const rule of profile.deniedToolNamePatterns) {
      if (matchAnchoredGlob(rule, toolCall.title)) {
        return { matchedBy: 'tool-name', rule, matched: toolCall.title };
      }
    }
  }

  return undefined;
}

/**
 * The session-start half of D3-4's "applied as a filter at session start":
 * drops any server whose `config.name` this profile denies, before the
 * caller (`@loombox/node`'s `NodeDaemon.resolveMcpServers`) ever hands the
 * result to `AgentSession.spawn()`. Unlike {@link evaluateAgentProfile},
 * this is a hard, un-bypassable gate — a denied server's tools genuinely
 * never exist for this session, since the agent never learns the server
 * was configured at all. `profile: undefined` returns `servers` unchanged.
 */
export function filterMcpServersForProfile<T extends { readonly name: string }>(
  servers: readonly T[],
  profile: AgentProfile | undefined,
): T[] {
  if (!profile || profile.deniedMcpServers.length === 0) return [...servers];
  const denied = new Set(profile.deniedMcpServers);
  return servers.filter((server) => !denied.has(server.name));
}
