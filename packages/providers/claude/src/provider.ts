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
 * in the `@zed-industries/claude-code-acp` bridge (the `claude-agent-acp`
 * project): it exposes its own CLI entrypoint, run via `npx`, which wraps the
 * `claude` CLI and speaks ACP JSON-RPC over stdio. This is the documented,
 * zero-install way to drive Claude Code as an ACP agent (no separate global
 * install required; `npx` resolves and caches the package on first run).
 *
 * The real `claude` binary can't be exercised headlessly in this dev
 * environment (see the integration test in this package), so this exact
 * command is validated against a real Claude Code install later, in issue
 * #54 (human-gated).
 *
 * **Capability-check finding (issue #184's last acceptance bullet):**
 * whether `@zed-industries/claude-code-acp` actually advertises
 * `promptCapabilities.image` at `initialize` time could not be verified in
 * this build environment — no real `claude` binary is installed, and this is
 * a network-isolated devbox, so `npx -y @zed-industries/claude-code-acp`
 * cannot be run to inspect its live `initialize` response. SPEC.md §7.25
 * documents the working assumption (grounded in the `claude-agent-acp`
 * `acp-agent.ts` source): Claude Code builds inline base64 image blocks.
 * This package's `buildClaudeImageContentBlock` (see `image.ts`) is written
 * capability-gated and fails closed on that assumption — it never emits an
 * image block unless the session's own negotiated `initialize` result says
 * so — so an incorrect assumption here degrades safely to the generic
 * temp-file fallback rather than sending a block an unadvertised agent
 * can't handle. Confirm the real advertisement against a live install in
 * issue #54 (human-gated).
 */
const CLAUDE_ACP_COMMAND = 'npx';
const CLAUDE_ACP_ARGS = ['-y', '@zed-industries/claude-code-acp'];

/**
 * The Claude Code provider adapter (SPEC.md §5.5, issue #49): supplies the
 * spawn config to launch Claude Code in ACP mode, registered under id
 * `'claude'`. `enrich()` is a no-op for v0 — promoting Claude's
 * `_meta.claudeCode.parentToolUseId` into a first-class `parentToolCallId`
 * is v2 work (SPEC.md §7.24, §12) and is deliberately not built here.
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
 * The v1 `AcpProviderModule` shape (issue #184, #181): registers under the
 * same `'claude'` id against `ProviderRegistry`, driving the fuller
 * `AcpTranscriptUpdate` surface (`tool_call`/`plan_update`/`usage_update`,
 * not just message chunks). `enrich()` is a deliberate pass-through/no-op
 * body for v1 — promoting Claude's vendor `_meta.claudeCode.
 * parentToolUseId` onto `parentToolCallId` is v2 subagent-tree work (SPEC.md
 * §7.24: "ships in v2") — but it is fully typed and wired against the
 * registry's real `enrich(update, raw)` contract now, so v2 can fill in the
 * promotion in this one function body with no registry or call-site change.
 */
export const claudeProviderModule: AcpProviderModule = {
  id: 'claude',

  spawnConfig(opts: { cwd: string }): AcpSpawnConfig {
    return {
      command: CLAUDE_ACP_COMMAND,
      args: CLAUDE_ACP_ARGS,
      cwd: opts.cwd,
    };
  },

  enrich(update: AcpTranscriptUpdate, _raw: unknown): AcpTranscriptUpdate {
    return update;
  },
};
