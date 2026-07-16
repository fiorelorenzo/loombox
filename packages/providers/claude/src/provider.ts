import type { AcpProvider, AcpSpawnConfig, AcpUpdate } from '@loombox/providers-core';

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
 */
const CLAUDE_ACP_COMMAND = 'npx';
const CLAUDE_ACP_ARGS = ['-y', '@zed-industries/claude-code-acp'];

/**
 * The Claude Code provider adapter (SPEC.md §5.5, issue #49): supplies the
 * spawn config to launch Claude Code in ACP mode, registered under id
 * `'claude'`. `enrich()` is a no-op for v0 — promoting Claude's
 * `_meta.claudeCode.parentToolUseId` into a first-class `parentToolCallId`
 * is v2 work (SPEC.md §7.24, §12) and is deliberately not built here.
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
