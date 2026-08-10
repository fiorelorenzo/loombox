# @loombox/providers-gemini

## 0.0.3

### Patch Changes

- Updated dependencies [e48bae0]
  - @loombox/providers-core@0.7.0
  - @loombox/providers-generic@0.0.8

## 0.0.2

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
  - @loombox/providers-generic@0.0.7

## 0.0.1

### Patch Changes

- aeb53fc: Build-time ACP completeness verification for Gemini CLI (issue #272)

  `packages/providers/gemini` was an untouched reserved stub (SPEC.md §5.5/§16's "verify its ACP
  flag at build time before promising the module" gate). This spike answers that: `gemini --acp`
  (the exact invocation `agent-catalogue.ts`'s `gemini-cli` entry already uses) is a real ACP v1
  agent, live-verified by spawning the real, published `@google/gemini-cli@0.54.0` over stdio with
  no credentials configured, corroborated against the real TypeScript source at the exact GitHub
  commit the `v0.54.0` tag resolves to.

  Findings, full citation trail in `docs/research/gemini-acp-completeness.md`:

  - The zero-code `generic` fallback tier already works against Gemini's real session/prompt/
    tool-call/permission/image loop — no bespoke adapter code needed for basic sessions.
  - Real gap (filed as #843): Gemini implements none of ACP v1's `session/resume`/`list`/`close`/
    `delete` — only the deprecated `session/load`, which `packages/providers/core`'s `resumeSession()`
    never calls. Confirmed both by a live JSON-RPC probe (`-32601 "Method not found"`, identical to a
    deliberately bogus method name) and by source (no such methods exist on `GeminiAgent`'s dispatch
    surface). `deriveFeatureFlags` already reports `supportsResume: false` correctly (issue #821's fix
    holds for a second real agent) — this is a genuine Gemini limitation, not a loombox bug.
  - Real gap (filed as #844): Gemini's `session/new` carries a non-standard `models` sub-object
    (paired with an `unstable_setSessionModel` method) that isn't part of ACP v1 and that
    `mapConfigOptions` never reads — no model-switcher UI is possible for Gemini today.
  - Corroborates issue #822 (not re-filed): Gemini's own `toAcpToolKind` also emits the real ACP
    `switch_mode` value `AcpToolKind`'s type union is still missing, a second real agent hitting the
    same gap Codex's spike found.

  New: `packages/providers/gemini/test/fixtures/gemini-acp-live-probe.json` (the real recorded
  JSON-RPC traffic) and `packages/providers/gemini/src/gemini-acp-capabilities.test.ts` (9 tests
  turning every citation into an assertion against it, plus real-shape conformance coverage for
  `deriveFeatureFlags`/`mapGenericPermissionOptions`/`classifyGenericToolKind`). `package.json` gained
  two ordinary workspace dependencies (`@loombox/providers-core`, `@loombox/providers-generic`) to
  exercise them — no new devDependency, `@google/gemini-cli` itself (20.7 MB / 448 files, unlike
  Codex's 1.2 MB single-file bundle) was deliberately not vendored; see the doc's Method section for
  the weight comparison that ruled it out.

  No adapter module shipped here — #273 is explicitly out of scope for this spike and remains a
  separate issue; `packages/providers/gemini/src/index.ts` is untouched.

  Verified: `pnpm --filter @loombox/providers-gemini exec vitest run` (2 files, 9 tests, all green),
  including a manual before/after regression proof (flipping the `sessionCapabilities` absence
  assertion to `.toBeDefined()` turns the suite red — `1 failed | 8 passed` — reverting turns it green
  again, `9 passed`; full output in `docs/research/gemini-acp-completeness.md`'s Executable checks
  section), `pnpm --filter @loombox/providers-gemini typecheck`, `pnpm exec eslint` on every changed
  file, and the full `pnpm format:check`.

- Updated dependencies [fc4f4e3]
- Updated dependencies [4e090fc]
- Updated dependencies [5f500de]
- Updated dependencies [05f8339]
  - @loombox/providers-core@0.5.0
  - @loombox/providers-generic@0.0.6
