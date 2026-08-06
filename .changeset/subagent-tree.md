---
'@loombox/providers-core': patch
'@loombox/providers-claude': patch
'@loombox/providers-codex': patch
'@loombox/web': patch
---

Subagent and nested tool-call tree rendering (issue #200; spike #199).

**What was checked before building anything (real runs, not inferred):**

- **Claude Code**, driven live against the real `@agentclientprotocol/claude-agent-acp` v0.65.0 npx bridge on this devbox: a Task-tool subagent's own nested tool calls arrive with `_meta.claudeCode.parentToolUseId` pointing at the launching tool call's own id (which itself carries `_meta.claudeCode.subagent: true`) — regardless of whether the client opts into the `subagent-transcript` capability. That capability only gates whether the subagent's own message/thinking text is _also_ forwarded (2 `agent_message_chunk`s without it vs. 5 with it, in the same live run); it does not gate tool-call nesting.
- **Codex**, source-verified against the published `@agentclientprotocol/codex-acp` (no live run possible — no `codex` CLI/credentials on this devbox): a spawned subagent surfaces as one summarizing `spawnAgent`/`subAgentActivity` tool call carrying thread-scoped `_meta.codex.collaboration`/`_meta.codex.subagent` metadata, reusing the same `toolCallId` throughout. The subagent's own individual tool calls are never forwarded as separate ACP events, so there is nothing to attribute a `parentToolCallId` to today.
- **`omp acp`** (oh-my-pi 17.2.9), driven live: a spawned subagent's tool activity is summarized inline inside the single spawning tool call's own `rawOutput` (`details.progress[].recentTools`), never emitted as separate ACP events, and the `subagent-transcript` capability is silently ignored.

**What shipped, given that:**

- `AcpClient.initialize()` now advertises `clientCapabilities._meta['subagent-transcript'] = true` (harmless for a provider that doesn't recognize it, verified against both `omp acp` and the Claude bridge).
- `@loombox/providers-claude`'s `claudeProviderModule.enrich()` promotes a real `_meta.claudeCode.parentToolUseId` onto `parentToolCallId`, replacing the old no-op — the exact signal verified live above. `@loombox/providers-codex`'s stays a no-op; its doc comment now records the source-verified reason instead of "not yet confirmed".
- `@loombox/providers-core`'s `transcript.ts` gains `computeToolCallNesting(items)`, a one-pass, per-`items`-reference lookup (`ReadonlyMap<id, { depth, parentTitle }>`) alongside the existing `ancestorChainForToolCall`. An orphan child — `parentToolCallId` set, but that id never arrived as its own item — resolves to `depth: 0`, identical to a genuine root call; a cycle is defused the same way. Exported from both `index.ts` and `browser.ts`.
- `@loombox/web`'s `TranscriptTimeline.svelte` renders a nested tool call indented (capped at 3 levels; true depth is preserved in `data-nesting-depth` regardless) with a "nested in …" caption naming the resolved immediate parent, computed from the _full_ transcript on every `items` change — never from the windowed/mounted slice, so a child renders correctly even while its parent's own row is scrolled out of the mounted window (#755). `ToolCallRow`'s own markup is untouched; nesting is purely a wrapper affordance on the `<li>`, so the one-line row shape (v7 C1-1) is unaffected.

Verification: `pnpm --filter @loombox/providers-core exec vitest run src/transcript.test.ts src/client.test.ts`, `pnpm --filter @loombox/providers-claude exec vitest run`, `pnpm --filter @loombox/providers-codex exec vitest run`, `pnpm --filter @loombox/web exec vitest run src/lib/components/TranscriptTimeline.test.ts src/lib/styles/tokens.test.ts src/lib/primitive-override-scope.test.ts`, `pnpm -r typecheck`, `pnpm exec eslint <changed files>`, `pnpm format:check`.
