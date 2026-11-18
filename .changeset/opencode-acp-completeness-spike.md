---
'@loombox/providers-opencode': patch
---

Build-time ACP completeness verification for OpenCode (issue #285)

New package: `packages/providers/opencode` is a capability-verification-test package (same shape
as `packages/providers/gemini`), not a shipped adapter — it answers SPEC.md §5.5/§16's "verify its
ACP flag at build time before promising the module" gate one candidate ahead of #286.

`opencode acp` (OpenCode's own documented ACP invocation, `opencode.ai/docs/acp`) is a real ACP v1
agent, live-verified with the fullest end-to-end session of any spike so far: `opencode-ai@1.18.16`
was installed for real (its `postinstall.mjs` downloads the real platform binary) and driven
through a full session — `initialize`, real `bash`/`write`/`read`/`edit` tool calls with a real
diff, a real `session/request_permission` round trip, real `session/set_config_option` model/mode
changes, and a real `session/resume`/`session/list`/`session/close` round trip against a session
that genuinely existed — corroborated against real TypeScript source at the exact GitHub commit
the `v1.18.16` tag resolves to (`anomalyco/opencode`, MIT).

Findings, full citation trail in `docs/research/opencode-acp-completeness.md`:

- The zero-code `generic` fallback tier already works against OpenCode's real session/prompt/
  tool-call/permission/config-option/resume loop end to end — no bespoke adapter code needed.
- `sessionCapabilities` is real and populated (`close`/`fork`/`list`/`resume`, only `delete`/
  `additionalDirectories` genuinely absent) — unlike Gemini, closer to Codex/`omp acp`. This is the
  first spike to actually exercise `AcpClient.resumeSession`'s real `session/resume` branch (not
  its `session/load` fallback) against a live agent.
- `session/new`'s real `configOptions` already arrive in the standard ACP shape (no vendor `models`
  sub-object the way Gemini's does) — both `model` and `mode` genuinely switch through the single
  standard `session/set_config_option` method, live-verified, no vendor fallback needed.
- Real gap, but not OpenCode-specific (filed as #957): `AcpClient.resumeSession`'s `session/resume`
  request never sends `mcpServers`, despite its own doc comment and a real, optional ACP v1 schema
  field — a resumed session's configured MCP servers are silently never re-registered. A
  pre-existing `packages/providers/core` bug this spike is simply the first to observe live.

New: `packages/providers/opencode/test/fixtures/opencode-acp-live-probe.json` (the real recorded
JSON-RPC traffic across six live recording runs) and
`packages/providers/opencode/src/opencode-acp-capabilities.test.ts` (13 tests turning every
citation into an assertion against it, plus real-shape conformance coverage for
`deriveFeatureFlags`/`reduceTranscript`'s tool-kind merge fallback/`mapGenericPermissionOptions`/
`classifyGenericToolKind`). `package.json` carries two ordinary workspace dependencies
(`@loombox/providers-core`, `@loombox/providers-generic`) to exercise them — no devDependency on
`opencode-ai` itself: its npm package is a 7.9 kB, 4-file postinstall wrapper with no bundled
source to vendor, see the doc's Method section.

No adapter module shipped here — #287 is explicitly out of scope for this spike and remains a
separate issue, closing on "nothing warranted" per this doc's own recommendation.
`agent-catalogue.ts` is untouched — registering OpenCode as a provider id is #286's scope, not
this spike's.

Verified: `pnpm --filter @loombox/providers-opencode test` (2 files, 14 tests, all green),
including a manual before/after regression proof (flipping the `sessionCapabilities.delete`/
`additionalDirectories` absence assertion to `.toBeDefined()` turns the suite red — `1 failed | 13
passed` — reverting turns it green again, `14 passed`; full output in
`docs/research/opencode-acp-completeness.md`'s Executable checks section), `pnpm --filter
@loombox/providers-opencode typecheck`, `pnpm exec eslint` on every changed file, and the full
`pnpm format:check`.
