import type {
  AcpProvider,
  AcpProviderModule,
  AcpSpawnConfig,
  AcpTranscriptUpdate,
  AcpUpdate,
} from '@loombox/providers-core';

/**
 * Claude Code's ACP bridge command.
 *
 * SPEC.md §16 ("Image hand-off — grounded inline base64 for both Claude
 * (`claude-agent-acp` `acp-agent.ts`)...") grounds Claude Code's ACP surface
 * in the `@agentclientprotocol/claude-agent-acp` bridge: it exposes its own
 * CLI entrypoint (`claude-agent-acp`), run via `npx`, which wraps the
 * `claude` CLI and speaks ACP JSON-RPC over stdio. This is the documented,
 * zero-install way to drive Claude Code as an ACP agent (no separate global
 * install required; `npx` resolves and caches the package on first run).
 *
 * This package used to spawn the predecessor `@zed-industries/claude-code-acp`
 * package (issue #382); that package now prints a deprecation notice at
 * startup pointing at this one — same maintainers, same ACP stdio bridge
 * over the `claude` binary, only the package name and bin changed (`npm
 * view` confirms `@agentclientprotocol/claude-agent-acp`'s `bin` entry is
 * `claude-agent-acp`, replacing `claude-code-acp`), so the swap is a
 * drop-in `npx -y <package>` rename with no other invocation change.
 *
 * The real `claude` binary can't be exercised headlessly in most CI/sandbox
 * environments (see the fixture-driven integration test in this package),
 * so this exact command was long assumed rather than verified. **Update
 * (issue #199/#200):** this devbox turned out to have both a real `claude`
 * CLI (already authenticated) and outbound network access, so the earlier
 * "network-isolated, cannot run npx" premise below no longer held — driven
 * live, `npx -y @agentclientprotocol/claude-agent-acp` v0.65.0 spawned and
 * spoke ACP exactly as documented.
 *
 * **Capability-check finding (issue #184's last acceptance bullet),
 * reconfirmed live for #200:** `initialize`'s real `agentCapabilities.
 * promptCapabilities` came back `{ image: true, embeddedContext: true }` —
 * the `image: true` assumption `buildClaudeImageContentBlock` (`image.ts`)
 * gates on is correct, not just a safe-if-wrong guess. SPEC.md §7.25's
 * documented working assumption (Claude Code builds inline base64 image
 * blocks, grounded in `claude-agent-acp`'s `acp-agent.ts` source) is now
 * grounded in the real binary's own wire response too.
 */
const CLAUDE_ACP_COMMAND = 'npx';
const CLAUDE_ACP_ARGS = ['-y', '@agentclientprotocol/claude-agent-acp'];

/**
 * The Claude Code provider adapter (SPEC.md §5.5, issue #49): supplies the
 * spawn config to launch Claude Code in ACP mode, registered under id
 * `'claude'`. `enrich()` is a no-op for v0 — this shape only ever carries
 * `AcpUpdate` (message chunks), which has no tool-call/`parentToolCallId`
 * surface to promote anything onto; see `claudeProviderModule` below (the
 * v1 `AcpTranscriptUpdate` shape) for the real `_meta.claudeCode.
 * parentToolUseId` promotion (issue #200).
 *
 * This is the v0 `AcpProvider` shape (single-arg `enrich`) that
 * `packages/supervisor` already depends on — kept byte-for-byte unchanged.
 * See `claudeProviderModule` below for the v1 `AcpProviderModule` shape
 * this same adapter registers under `ProviderRegistry`.
 */
export const claudeProvider: AcpProvider = {
  id: 'claude',

  spawnConfig(opts: { cwd: string }): AcpSpawnConfig {
    return {
      command: CLAUDE_ACP_COMMAND,
      args: CLAUDE_ACP_ARGS,
      cwd: opts.cwd,
    };
  },

  enrich(update: AcpUpdate): AcpUpdate {
    return update;
  },
};

/**
 * Reads a Claude ACP bridge's own vendor `_meta.claudeCode.parentToolUseId`
 * off a raw `session/update` payload (issue #199/#200) — verified with a
 * live run against the real `@agentclientprotocol/claude-agent-acp` v0.65.0
 * npx bridge on a subagent (Task tool) turn: the SUBAGENT'S OWN nested
 * `tool_call`/`tool_call_update` notifications carried this exact `_meta`
 * shape, pointing at the launching Agent/Task call's own `toolCallId`
 * (which itself carries `_meta.claudeCode.subagent: true`) — observed
 * whether or not `AcpClient.initialize()` advertised the `subagent-
 * transcript` client capability (`packages/providers/core/src/client.ts`);
 * that capability only gates whether the subagent's own message/thinking
 * text is ALSO forwarded, not whether its tool calls are. `undefined` for
 * anything else, including a malformed/non-object `raw` — this must never
 * throw, since a provider's `enrich()` runs on every single update.
 * Exported for direct unit testing, the same "no fixture process needed"
 * convention `mapConfigOptions`/`mapToTranscriptUpdate`
 * (`packages/providers/core/src/client.ts`) already use for their own wire
 * mapping.
 */
export function claudeParentToolCallId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const meta = (raw as { _meta?: unknown })._meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const claudeCode = (meta as { claudeCode?: unknown }).claudeCode;
  if (typeof claudeCode !== 'object' || claudeCode === null) return undefined;
  const parentToolUseId = (claudeCode as { parentToolUseId?: unknown }).parentToolUseId;
  return typeof parentToolUseId === 'string' && parentToolUseId.length > 0
    ? parentToolUseId
    : undefined;
}

/**
 * The v1 `AcpProviderModule` shape (issue #184, #181; real promotion added
 * for #199/#200): registers under the same `'claude'` id against
 * `ProviderRegistry`, driving the fuller `AcpTranscriptUpdate` surface
 * (`tool_call`/`plan_update`/`usage_update`, not just message chunks).
 * `enrich()` promotes Claude's vendor `_meta.claudeCode.parentToolUseId`
 * onto `parentToolCallId` for a `tool_call`/`tool_call_update` — see
 * {@link claudeParentToolCallId}'s own doc comment for how this was
 * verified against the real bridge. Only a tool-call-kind update is ever
 * touched (a message chunk/plan/usage update has no `parentToolCallId`
 * field on its own type to promote onto), and an update that already
 * carries its own `parentToolCallId` — from a hypothetical future ACP
 * revision that standardizes a real top-level wire field — is never
 * clobbered; the vendor `_meta` promotion only ever fills a gap.
 *
 * `requiredCommand` is `'claude'`, not `'npx'`: `CLAUDE_ACP_COMMAND` above
 * is the launcher, but the vendor CLI the npx-resolved bridge wraps — and
 * the one that must actually exist on the execution target's PATH — is
 * `claude` itself (design spec "Provider availability is per TARGET, not
 * per node": an `ssh:` target spawns remotely, so it's that host's PATH
 * that matters, never the node's).
 */
export const claudeProviderModule: AcpProviderModule = {
  id: 'claude',
  requiredCommand: 'claude',

  spawnConfig(opts: { cwd: string }): AcpSpawnConfig {
    return {
      command: CLAUDE_ACP_COMMAND,
      args: CLAUDE_ACP_ARGS,
      cwd: opts.cwd,
    };
  },

  enrich(update: AcpTranscriptUpdate, raw: unknown): AcpTranscriptUpdate {
    if (update.kind !== 'tool_call' && update.kind !== 'tool_call_update') return update;
    if (update.parentToolCallId !== undefined) return update;
    const parentToolCallId = claudeParentToolCallId(raw);
    return parentToolCallId === undefined ? update : { ...update, parentToolCallId };
  },
};
