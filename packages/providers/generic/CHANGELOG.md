# @loombox/providers-generic

## 0.0.7

### Patch Changes

- Updated dependencies [0ca76ea]
- Updated dependencies [24c9e77]
- Updated dependencies [b39f9c1]
- Updated dependencies [c1c852d]
- Updated dependencies [b389ef8]
- Updated dependencies [18f2885]
- Updated dependencies [827b157]
  - @loombox/providers-core@0.6.0

## 0.0.6

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

- Updated dependencies [fc4f4e3]
- Updated dependencies [4e090fc]
- Updated dependencies [5f500de]
- Updated dependencies [05f8339]
  - @loombox/providers-core@0.5.0

## 0.0.5

### Patch Changes

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

- Updated dependencies [55161ed]
- Updated dependencies [fcb76fc]
  - @loombox/providers-core@0.1.0
