---
'@loombox/providers-core': minor
'@loombox/providers-claude': minor
'@loombox/providers-codex': minor
'@loombox/node': minor
'@loombox/supervisor': minor
---

Codex inline base64 image hand-off (SPEC §7.25 "Hand off to the agent"; issue #158)

An image attached in the composer now reaches a live agent turn as a real ACP `ContentBlock::Image`, not just as `blob_ref` metadata:

- `@loombox/providers-core` gains `buildInlineImageContentBlock`, the one capability-gated inline base64 builder both `@loombox/providers-claude`'s `buildClaudeImageContentBlock` and `@loombox/providers-codex`'s `buildCodexImageContentBlock` now re-export under their own adapter-named symbol — SPEC.md §7.25 confirms both adapters' real ACP bridges build the identical `data:`-style block, so unifying the two previously-duplicated implementations follows the spec's own "unified, not special-cased" language rather than inventing a new shape. The builder checks capability, then a 10 MB size cap (`MAX_INLINE_IMAGE_BYTES`, overridable per call), then re-sniffs the bytes against the four supported formats, returning a typed `{ ok: true, block }` / `{ ok: false, reason }` result instead of `undefined` — a caller can now tell "capability not negotiated" apart from "oversize" apart from "unsupported format."
- `AcpClient.prompt()` and `AgentSession.prompt()` both grew an `extraContent: AcpPromptContentBlock[]` parameter (default `[]`, every existing plain-text caller unaffected) appended after the required text block. `AgentSession.getFeatureFlags()` exposes the session's negotiated `AcpFeatureFlags` (including `supportsImages`) the same way `configOptions`/`availableCommands` already do.
- `@loombox/node`'s `NodeDaemon.deliverPrompt` runs each resolved attachment through `buildInlineImageContentBlock`, gated on `agentSession.getFeatureFlags().supportsImages`, and appends a successful build to the turn's content blocks. A declined hand-off (capability not negotiated, oversize, or unsupported format) never blocks the turn — it emits a new `'attachment_handoff_declined'` event for observability and the prompt still reaches the agent as text, exactly as before this issue.

Verified: `pnpm --filter @loombox/providers-core --filter @loombox/providers-claude --filter @loombox/providers-codex --filter @loombox/node --filter @loombox/supervisor test -- --run` (all green; one unrelated pre-existing timing-sensitive test in `attachments-e2e.test.ts`'s bounded-queue describe block flaked once under full-suite parallel load with its default 5s timeout and passed cleanly on every isolated/solo run), `pnpm --filter @loombox/providers-core --filter @loombox/providers-claude --filter @loombox/providers-codex --filter @loombox/node --filter @loombox/supervisor typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

No real `codex` binary is installed on this box (`which codex` fails), so the exact payload shape Codex expects is proven against `codex-like-acp-agent.mjs`, a hermetic fixture agent driven over a real JSON-RPC/stdio child process (`packages/providers/codex/src/conformance.test.ts` and the two new `packages/node/src/attachments-e2e.test.ts` cases) — not against a real Codex install. The real `codex-acp` bridge's `promptCapabilities.image` advertisement itself is still unconfirmed against a live binary (tracked separately, issue #54).
