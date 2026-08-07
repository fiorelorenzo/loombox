# @loombox/providers-gemini

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
