import type {
  AcpProvider,
  AcpProviderModule,
  AcpSpawnConfig,
  AcpTranscriptUpdate,
  AcpUpdate,
} from '@loombox/providers-core';

/**
 * Codex's ACP bridge command.
 *
 * SPEC.md §16 ("Image hand-off — grounded inline base64 for both Claude
 * (`claude-agent-acp` `acp-agent.ts`) and Codex (`codex-acp`
 * `CodexAcpClient.ts`)") grounds Codex's ACP surface in the `codex-acp`
 * project (published to npm as `@agentclientprotocol/codex-acp`, the
 * maintained successor to the earlier `@zed-industries/codex-acp` name): it
 * exposes its own CLI entrypoint, run via `npx`, which wraps the `codex` CLI
 * and speaks ACP JSON-RPC over stdio — the same zero-install pattern
 * `@loombox/providers-claude`'s `CLAUDE_ACP_COMMAND` uses for Claude Code.
 *
 * The real `codex` binary can't be exercised headlessly in this dev
 * environment (see the fixture-driven conformance suite in this package),
 * and its ACP completeness against core's expectations has not been
 * verified against a live install (SPEC.md §10/§12's explicit "Codex's ACP
 * completeness verified at build time" gate) — this module is built and
 * tested entirely against a Codex-shaped hermetic fixture
 * (`packages/providers/core/test/fixtures/codex-like-acp-agent.mjs`), which
 * is why issue #186's Codex half (fixture + conformance coverage) is what
 * this module ships against, not a real-binary smoke test. That
 * verification, and gating the real spawn command on its result, is a
 * separate human-gated follow-up.
 */
const CODEX_ACP_COMMAND = 'npx';
const CODEX_ACP_ARGS = ['-y', '@agentclientprotocol/codex-acp'];

/**
 * The Codex provider adapter (SPEC.md §5.5, issue #186's Codex half):
 * supplies the spawn config to launch Codex in ACP mode, registered under id
 * `'codex'`. `enrich()` is a no-op: Codex has no confirmed vendor `_meta`
 * parent-link signal yet (SPEC.md §7.24: "Codex until an equivalent signal
 * is confirmed" degrades to a flat list automatically), unlike Claude's
 * `_meta.claudeCode.parentToolUseId` promotion (itself still v2-scoped and
 * also a no-op today).
 *
 * This is the v0 `AcpProvider` shape (single-arg `enrich`), kept for parity
 * with `@loombox/providers-claude`'s `claudeProvider` in case a future
 * consumer needs it. See `codexProviderModule` below for the v1
 * `AcpProviderModule` shape this same adapter registers under
 * `ProviderRegistry`.
 */
export const codexProvider: AcpProvider = {
  id: 'codex',

  spawnConfig(opts: { cwd: string }): AcpSpawnConfig {
    return {
      command: CODEX_ACP_COMMAND,
      args: CODEX_ACP_ARGS,
      cwd: opts.cwd,
    };
  },

  enrich(update: AcpUpdate): AcpUpdate {
    return update;
  },
};

/**
 * The v1 `AcpProviderModule` shape (issue #186's Codex half, #181): registers
 * under the same `'codex'` id against `ProviderRegistry`, driving the fuller
 * `AcpTranscriptUpdate` surface (`tool_call`/`plan_update`/`usage_update`,
 * not just message chunks). `enrich()` is a deliberate pass-through/no-op
 * body — see `codexProvider`'s doc comment for why — but it is fully typed
 * and wired against the registry's real `enrich(update, raw)` contract now.
 */
export const codexProviderModule: AcpProviderModule = {
  id: 'codex',

  spawnConfig(opts: { cwd: string }): AcpSpawnConfig {
    return {
      command: CODEX_ACP_COMMAND,
      args: CODEX_ACP_ARGS,
      cwd: opts.cwd,
    };
  },

  enrich(update: AcpTranscriptUpdate, _raw: unknown): AcpTranscriptUpdate {
    return update;
  },
};
