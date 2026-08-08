# @loombox/providers-codex

## 0.1.2

### Patch Changes

- @loombox/providers-core@0.6.1

## 0.1.1

### Patch Changes

- 0ca76ea: Core-level `session/load` fallback for agents with no ACP v1 session-lifecycle methods beyond the deprecated one (SPEC.md §5.5; issue #843, filed by issue #272's Gemini spike)

  Issue #272's live probe against the real, published `npx -y @google/gemini-cli@0.54.0 --acp` found Gemini CLI genuinely implements none of ACP v1's `session/resume`/`list`/`close`/`delete` (`-32601 "Method not found"`, the identical code a deliberately bogus method name gets) — only the older, superseded `session/load`, gated by its own `loadSession` flag rather than the `sessionCapabilities` object issue #821 already taught `deriveFeatureFlags` to read. The spike's own note said the fix, if taken, belongs at the `packages/providers/core` level, not per-provider, since every ACP agent that hasn't migrated off `session/load` yet benefits identically. This ships that fix:

  - `packages/providers/core/src/client.ts`'s `AcpClient.resumeSession()` now branches on the connected agent's real negotiated capabilities: real `session/resume` (`sessionCapabilities.resume` present) is tried first exactly as before; an agent that advertises `loadSession` but not `sessionCapabilities.resume` gets `session/load` instead, sent with the real ACP v1 `LoadSessionRequest` shape (`sessionId`+`cwd`+`mcpServers`, the new `ResumeSessionOptions` third parameter — defaulting to `[]`, same shape as `newSession`'s `NewSessionOptions`). Both paths run through the exact same `session/update`-notification reducer already proven for `session/resume` (SPEC.md §7.24), since `session/load` is documented to replay history the same way. An agent advertising neither is refused up front with an actionable error rather than reaching the agent's own `-32601`.
  - `packages/providers/core/src/capabilities.ts`'s `deriveFeatureFlags` widens `supportsResume` to `sessionCapabilities.resume != null || loadSession === true`: since the fallback above makes `session/load`-only resume genuinely work, reporting `supportsResume: false` in that case would be capability reporting saying what we wish were true rather than what's genuinely available — the opposite of what issue #821 established this flag for. `supportsAdditionalDirectories`/`supportsSessionDelete` are unaffected: `session/load` has no equivalent fallback for either.
  - New fixture `packages/providers/core/test/fixtures/gemini-like-acp-agent.mjs`, byte-shaped after the real, live-recorded probe (`packages/providers/gemini/test/fixtures/gemini-acp-live-probe.json`, `docs/research/gemini-acp-completeness.md`): `loadSession: true`, no `sessionCapabilities` at all, `session/load` implemented (replays a deliberately-gapped history), `session/resume`/`list`/`close`/`delete` genuinely unimplemented (same `-32601` the real binary returns). New `packages/providers/core/src/gemini-like-conformance.test.ts` proves a resumed session round-trips history correctly and stays usable for a live follow-up `session/prompt` turn through this fixture, with no bespoke Gemini adapter code loaded — matching SPEC.md §5.5's "Gemini rides the generic tier" design.
  - `packages/providers/core/test/fixtures/resumable-acp-agent.mjs` (issue #176's original session/resume fixture) now advertises `sessionCapabilities: { resume: {}, list: {} }` instead of just `loadSession: true` — it genuinely implements `session/resume`/`session/list`, not `session/load`, so the old capability shape would have been exactly the dishonest-reporting bug this issue exists to fix, and would have silently made `resumeSession()` take the new fallback branch against a fixture that doesn't implement it.
  - `packages/providers/codex/src/codex-acp-capabilities.test.ts` and `packages/providers/gemini/src/gemini-acp-capabilities.test.ts`: the pre-#843 assertions that `supportsResume` stays `false` for a `loadSession`-only agent are flipped to `true`, since that's now genuinely accurate. Real Codex (which sets both `loadSession` and `sessionCapabilities.resume`) is unaffected either way.

  Claude's and Codex's own conformance/capability suites are untouched and stay green: both fixtures already set `sessionCapabilities.resume`, so `resumeSession()` takes the unchanged real-`session/resume` branch exactly as before.

  Verified: `pnpm --filter @loombox/providers-core exec vitest run` (26 files, 318 tests), `pnpm --filter @loombox/providers-codex exec vitest run` (7 files, 46 tests), `pnpm --filter @loombox/providers-gemini exec vitest run` (2 files, 9 tests), `pnpm --filter @loombox/providers-claude exec vitest run` (6 files, 30 tests, unaffected/green), `pnpm --filter @loombox/providers-generic exec vitest run` and `pnpm --filter @loombox/providers-ohmypi exec vitest run` (unaffected/green), `typecheck` on `providers-core`/`providers-codex`/`providers-gemini`/`providers-claude`/`providers-generic`/`providers-ohmypi`/`node`/`web` (all clean), `pnpm exec eslint` on every changed file (clean), and the full `pnpm format:check` (clean).

- Updated dependencies [0ca76ea]
- Updated dependencies [24c9e77]
- Updated dependencies [b39f9c1]
- Updated dependencies [c1c852d]
- Updated dependencies [b389ef8]
- Updated dependencies [18f2885]
- Updated dependencies [827b157]
  - @loombox/providers-core@0.6.0

## 0.1.0

### Minor Changes

- 4e090fc: Codex inline base64 image hand-off (SPEC §7.25 "Hand off to the agent"; issue #158)

  An image attached in the composer now reaches a live agent turn as a real ACP `ContentBlock::Image`, not just as `blob_ref` metadata:

  - `@loombox/providers-core` gains `buildInlineImageContentBlock`, the one capability-gated inline base64 builder both `@loombox/providers-claude`'s `buildClaudeImageContentBlock` and `@loombox/providers-codex`'s `buildCodexImageContentBlock` now re-export under their own adapter-named symbol — SPEC.md §7.25 confirms both adapters' real ACP bridges build the identical `data:`-style block, so unifying the two previously-duplicated implementations follows the spec's own "unified, not special-cased" language rather than inventing a new shape. The builder checks capability, then a 10 MB size cap (`MAX_INLINE_IMAGE_BYTES`, overridable per call), then re-sniffs the bytes against the four supported formats, returning a typed `{ ok: true, block }` / `{ ok: false, reason }` result instead of `undefined` — a caller can now tell "capability not negotiated" apart from "oversize" apart from "unsupported format."
  - `AcpClient.prompt()` and `AgentSession.prompt()` both grew an `extraContent: AcpPromptContentBlock[]` parameter (default `[]`, every existing plain-text caller unaffected) appended after the required text block. `AgentSession.getFeatureFlags()` exposes the session's negotiated `AcpFeatureFlags` (including `supportsImages`) the same way `configOptions`/`availableCommands` already do.
  - `@loombox/node`'s `NodeDaemon.deliverPrompt` runs each resolved attachment through `buildInlineImageContentBlock`, gated on `agentSession.getFeatureFlags().supportsImages`, and appends a successful build to the turn's content blocks. A declined hand-off (capability not negotiated, oversize, or unsupported format) never blocks the turn — it emits a new `'attachment_handoff_declined'` event for observability and the prompt still reaches the agent as text, exactly as before this issue.

  Verified: `pnpm --filter @loombox/providers-core --filter @loombox/providers-claude --filter @loombox/providers-codex --filter @loombox/node --filter @loombox/supervisor test -- --run` (all green; one unrelated pre-existing timing-sensitive test in `attachments-e2e.test.ts`'s bounded-queue describe block flaked once under full-suite parallel load with its default 5s timeout and passed cleanly on every isolated/solo run), `pnpm --filter @loombox/providers-core --filter @loombox/providers-claude --filter @loombox/providers-codex --filter @loombox/node --filter @loombox/supervisor typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

  No real `codex` binary is installed on this box (`which codex` fails), so the exact payload shape Codex expects is proven against `codex-like-acp-agent.mjs`, a hermetic fixture agent driven over a real JSON-RPC/stdio child process (`packages/providers/codex/src/conformance.test.ts` and the two new `packages/node/src/attachments-e2e.test.ts` cases) — not against a real Codex install. The real `codex-acp` bridge's `promptCapabilities.image` advertisement itself is still unconfirmed against a live binary (tracked separately, issue #54).

### Patch Changes

- fc4f4e3: Fix `AcpAgentCapabilities` to read real ACP v1 fields, not invented ones (issue #821)

  The #182 build-time verification spike (`docs/research/codex-acp-completeness.md`, cross-checked against `@agentclientprotocol/codex-acp@1.1.10`'s bundled `@agentclientprotocol/sdk` zod schema and a real `omp acp` binary recording) found `AcpAgentCapabilities` declared five top-level fields real ACP v1 doesn't have. Each phantom field is fixed or removed:

  - `additionalDirectories` / `sessionDelete` were real capabilities, just flattened wrong. They now live where the wire actually puts them: a new `AcpSessionCapabilities` type on `AcpAgentCapabilities.sessionCapabilities`, read as `.additionalDirectories` / `.delete`. Presence (even an empty `{}`) means supported, absence means not — matching the real `zSessionCapabilities` schema.
  - `mcpServerPicker`, `requestPermission`, `plans` don't exist anywhere in the real schema, in any nesting (grepped the full bundled source: zero hits as capability fields). Nothing downstream ever read the flags `deriveFeatureFlags` derived from them, so there was no honest value to keep deriving — removed outright, along with `AcpFeatureFlags.supportsMcpServerPicker` / `.supportsPermissions` / `.supportsPlans`. `session/request_permission` in particular isn't gated by any capability at all: `AcpClient` answers it unconditionally regardless of what `initialize` advertises, so a flag that never varies with the session wasn't real capability negotiation.
  - `supportsResume` read the wrong field entirely: `agentCapabilities.loadSession` gates the older `session/load` method, not `session/resume`, which is what `AcpClient.resumeSession()` actually calls and which is gated by the separate `sessionCapabilities.resume`. Fixed to read the field that gates the method this client calls. The two happen to agree for Codex today (it sets both), which is exactly how this sat unnoticed.

  `AcpFeatureFlags` is now: `supportsImages`, `supportsAudio`, `supportsEmbeddedContext`, `supportsResume`, `supportsAdditionalDirectories`, `supportsSessionDelete`. No caller outside `packages/providers/core`'s own tests reads any of the removed flags today (checked: `packages/node`, `packages/supervisor`, `apps/web` only ever read `supportsImages`), so this is a type/behavior fix with no live UI impact.

  New coverage: `client.test.ts` gained a `deriveFeatureFlags` suite driven directly off `test/fixtures/omp-acp-session-new-response.json`, a response recorded from spawning the real `omp acp` binary (v17.2.9) over stdio — not a hand-built fixture. `codex-acp-capabilities.test.ts`'s `[known gap, issue #821]` test is flipped to prove the fix against Codex's real, source-verified `agentCapabilities` shape. Every fixture agent's `agentCapabilities` (`claude-like`/`codex-like`/`config`/`permission-acp-agent.mjs`) now sends the real nested shape instead of the invented flat one; `codex-like-acp-agent.mjs`'s is the literal shape verified against the pinned `codex-acp` source.

  Verified: `pnpm --filter @loombox/providers-core --filter @loombox/providers-claude --filter @loombox/providers-codex --filter @loombox/providers-generic --filter @loombox/providers-ohmypi test -- --run` (25+6+7+7+6 = 51 files, 312+30+41+7+23 = 413 tests, all green), the same five packages' `typecheck` (all green), `pnpm exec eslint` on every changed file (clean), and the full `pnpm format:check` (clean, after one `prettier --write` on a test file's reformatted object literal).

  While in this file, this branch independently hit and fixed the same pre-existing type error #834 fixed on `main` the same night: `codex-acp-capabilities.test.ts` asserted `block?.mimeType` on `buildCodexImageContentBlock`'s result, but #158 had already changed that return type to a discriminated `{ok: true, block} | {ok: false, reason}` union. My fix landed while this branch was in flight; once I saw #834 had already fixed the exact same lines on `main`, I aligned this branch's version to match #834's wording exactly so the hunk merges cleanly rather than as a redundant divergent diff.

- 5f500de: Fix Codex's permission-option verb classification against real button text, and correct SPEC.md's guessed labels (issue #820, spike #182)

  `@agentclientprotocol/codex-acp@1.1.10`'s real `CodexApprovalHandler` labels its permission buttons "Allow Once" / "Allow for Session" (or "Allow Host/Root for Session") / "Reject" — never the "Yes" / "Yes, for this session" / "Stop, and explain what to do differently" text SPEC.md §7.24 and `packages/providers/codex/src/permissions.ts` assumed (`docs/research/codex-acp-completeness.md` §4). The rendered permission card was never actually wrong — `PermissionCard.svelte` always renders the agent's own `option.name` verbatim, never a per-provider label table — but `mapCodexPermissionOptions`'s text-matching classifier never fired against real Codex text (it only ever hit its own kind-based fallback), and nothing in the real source supports the "abort, not a deny" distinction SPEC.md drew for Codex's reject option, which is exactly as ordinary as Claude's or the generic tier's.

  - `@loombox/providers-codex`'s `CodexPermissionVerb` is renamed from `'yes' | 'yes_for_session' | 'stop_and_explain'` to `'allow_once' | 'allow_for_session' | 'reject'`, matching Claude's own verb-naming convention. `classify()`'s text patterns now match the real label vocabulary (`reject`, `session`, `allow once`) as the primary path, narrowly enough that an execpolicy/network-policy amendment option's "Allow Commands Starting With ..."/"Allow <host> in the Future" text still falls through to the kind-based fallback instead of misclassifying a persistent grant as one-time.
  - SPEC.md §7.24 corrected to cite the real labels and the verifying research doc, dropping the unevidenced "abort, not a deny" claim.
  - `packages/providers/core/test/fixtures/codex-like-acp-agent.mjs`'s `session/request_permission` fixture now sends the real option shapes, so every conformance suite drives real data instead of the fictional text.

  Verified: `pnpm --filter @loombox/providers-codex --filter @loombox/providers-core --filter @loombox/web --filter @loombox/node exec vitest run` (all green, including two new `PermissionCard.test.ts` cases proving the UI names real Codex option shapes correctly and that Claude's own five-verb labels keep working unaffected), `pnpm --filter @loombox/providers-codex --filter @loombox/providers-core --filter @loombox/web typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

- 97472a2: Fix Codex bespoke tool-widget matching against real tool-call titles (issue #819)

  `codexBespokeToolName`/`hasCodexBespokeWidget` (`packages/providers/codex/src/tool-widgets.ts`) matched a tool call's `title` against a case-insensitive `'patch'`/`'diff'`/`'bash'` prefix — an assumption issue #182's build-time verification spike (`docs/research/codex-acp-completeness.md` §3) proved no real Codex tool call ever satisfies, so these functions never fired for a real Codex session and every Codex tool call fell through to the generic row.

  Matched structurally against the real wire shape instead:

  - A file-change tool call is always titled literally `"Editing files"` with `toolKind: 'edit'` — never `"Patch(...)"`/`"Diff(...)"`. Codex has no separate patch vs. diff tool call, so both collapse into one `'edit'` bespoke name (`CodexBespokeToolName` is now `'edit' | 'bash'`, was `'patch' | 'diff' | 'bash'`).
  - A shell-command tool call's title is the arbitrary command text itself, its `bash`/`zsh`/`sh` prefix already stripped before the title is built — title text can never identify it. Matched by `toolKind: 'execute'` alone, mirroring `apps/web`'s already-fixed `resolveToolWidgetKind` (issue #623), which routes the same way for the same reason.

  Both functions now read `toolKind` in addition to `title` (their `Pick<AcpToolCallUpdate, ...>` parameter grew accordingly).

  The same class of bug (an unconfirmed title-prefix guess) still exists in `@loombox/providers-claude`'s `claudeBespokeToolName`/`hasClaudeBespokeWidget` — its own doc comment already tracks this as issue #54; deliberately left untouched here, a Codex-only fix.

  Verified: `pnpm --filter @loombox/providers-codex exec vitest run` (42 passed; 1 pre-existing failure in `codex-acp-capabilities.test.ts`'s `buildCodexImageContentBlock`/`InlineImageHandoffResult` mimeType assertion, unrelated to this change and reproduced identically on a clean `origin/main` checkout before any of this PR's edits), `pnpm --filter @loombox/providers-codex typecheck` (same single pre-existing failure, same line, reproduced pre-existing), `pnpm exec eslint` on every changed file (clean), and the full `pnpm format:check` (clean).

- Updated dependencies [fc4f4e3]
- Updated dependencies [4e090fc]
- Updated dependencies [5f500de]
- Updated dependencies [05f8339]
  - @loombox/providers-core@0.5.0

## 0.0.5

### Patch Changes

- 1ae1def: Subagent and nested tool-call tree rendering (issue #200; spike #199).

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

- Updated dependencies [f2d51ee]
- Updated dependencies [a0fb0a6]
- Updated dependencies [0c46b48]
- Updated dependencies [ae1498a]
- Updated dependencies [79f55e0]
- Updated dependencies [6d3ad95]
- Updated dependencies [6325366]
- Updated dependencies [757fa0e]
- Updated dependencies [1ae1def]
- Updated dependencies [00e8789]
  - @loombox/providers-core@0.4.0

## 0.0.4

### Patch Changes

- Updated dependencies [6f5dbe0]
- Updated dependencies [3e2e5f4]
- Updated dependencies [ff47e23]
  - @loombox/providers-core@0.3.1

## 0.0.3

### Patch Changes

- Updated dependencies [79f9f19]
- Updated dependencies [29da402]
  - @loombox/providers-core@0.3.0

## 0.0.2

### Patch Changes

- Updated dependencies [d09e12b]
- Updated dependencies [fc2c12e]
  - @loombox/providers-core@0.2.0

## 0.0.1

### Patch Changes

- fcb76fc: Offer the agents a target can actually run, and fix what the forms ask. Nodes now probe each target's own PATH and announce which providers work there, so the agent picker is a real choice instead of a hardcoded one-option dropdown. Adds Codex and Oh My Pi as real providers alongside Claude Code. The new-session dialog leads with the starting prompt, no longer reshapes itself ten seconds after opening, and every form marks the one required field instead of labelling the four optional ones.
- Updated dependencies [55161ed]
- Updated dependencies [fcb76fc]
  - @loombox/providers-core@0.1.0
