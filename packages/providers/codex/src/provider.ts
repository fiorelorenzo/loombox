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
 * `'codex'`. `enrich()` is a no-op.
 *
 * **Spike finding (issue #199), source-verified against the published
 * `@agentclientprotocol/codex-acp` (main branch source, matching the
 * `0.146.1`-era npm release — no live run: this devbox has no `codex` CLI
 * or credentials, only the bridge package itself, which wraps `codex` and
 * refuses to run without it):** Codex does NOT have a Claude-shaped
 * `parentToolUseId`-equivalent. A spawned subagent surfaces as ONE
 * summarizing tool call (`spawnAgent`, wire type `collabAgentToolCall`)
 * carrying `_meta.codex.collaboration.{senderThreadId,receiverThreadIds}`,
 * further updated in place by `subAgentActivity` events ("Start subagent
 * X" / "Interact with subagent X" / "Interrupt subagent X" —
 * `CodexToolCallMapper.ts`'s `createSubAgentActivityUpdate`) carrying
 * `_meta.codex.subagent.{threadId,path,activity}` — REUSING the same
 * `toolCallId` as the spawn call, never a new one. The subagent's own
 * individual tool calls (the Bash/Edit/etc. it actually runs) are never
 * forwarded as separate ACP `tool_call` events at all — there is nothing
 * to attribute a `parentToolCallId` to. Both `_meta` shapes key on a
 * THREAD id, not a tool-call id, so a client-side promotion would need a
 * different mechanism than Claude's straight `_meta` field read: matching
 * a `subAgentActivity`'s `threadId` back to whichever `spawnAgent` call's
 * `receiverThreadIds` contains it — and even then there'd be exactly one
 * child row per subagent (the activity marker), never that subagent's own
 * nested tree. What Codex would need to ship for real per-tool-call
 * nesting: forward the subagent's own tool calls as distinct ACP
 * `tool_call`/`tool_call_update` events, each carrying a link back to the
 * spawning `toolCallId` (mirroring Claude's `_meta.claudeCode.
 * parentToolUseId`) — today's thread-scoped summary is not that. Until
 * then this stays flat, exactly as SPEC.md §7.24 already called out
 * ("Codex until an equivalent signal is confirmed" degrades to a flat
 * list) — now confirmed, not just assumed.
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
 * body — see `codexProvider`'s doc comment for the source-verified reason
 * (issue #199/#200) — but it is fully typed and wired against the
 * registry's real `enrich(update, raw)` contract now, so a future Codex
 * bridge release that adds real per-tool-call parent linkage needs only
 * this one function body filled in, not a registry or call-site change.
 *
 * `requiredCommand` is `'codex'`, not `'npx'`: `CODEX_ACP_COMMAND` above is
 * the launcher, but the vendor CLI the npx-resolved bridge wraps — and the
 * one that must actually exist on the execution target's PATH — is `codex`
 * itself (design spec "Provider availability is per TARGET, not per node":
 * an `ssh:` target spawns remotely, so it's that host's PATH that matters,
 * never the node's — verified concretely on the devbox, where `claude` and
 * `omp` are on PATH but `codex` is not).
 */
export const codexProviderModule: AcpProviderModule = {
  id: 'codex',
  requiredCommand: 'codex',

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
