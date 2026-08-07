---
'@loombox/providers-core': patch
'@loombox/web': patch
---

Add the real ACP v1 `switch_mode` tool-call kind (issue #822, corroborated by #272)

`AcpToolKind` (`packages/providers/core/src/types.ts`) only carried nine of the real ACP v1 `zToolKind` enum's ten members. Both the Codex and the Gemini ACP completeness spikes hit the same gap independently: Gemini CLI's own `toAcpToolKind` already passes `Kind.SwitchMode` straight through as the literal wire value `'switch_mode'` today, so this was not a theoretical future-agent risk.

- `AcpToolKind` and `acp-wire-schema.ts`'s `acpToolKindSchema` both gain `'switch_mode'` as a tenth member.
- `apps/web`'s `toolKindIcon` gets a new `tool-switch-mode` glyph (a toggle-track pill), so a `switch_mode` tool call renders through the generic row with its own icon instead of falling into the `tool-generic` wrench a truly unrecognized kind gets.
- Audited the rest of the `AcpToolKind` list against both spikes' citations of the real ACP schema (`docs/research/codex-acp-completeness.md`, `docs/research/gemini-acp-completeness.md`): the other nine members (`read`/`edit`/`delete`/`move`/`search`/`execute`/`think`/`fetch`/`other`) are complete — `switch_mode` was the only gap.

Verified: `pnpm --filter @loombox/providers-core exec vitest run src/acp-wire-schema.test.ts` (15 tests), `pnpm --filter @loombox/web exec vitest run src/lib/tool-widgets.test.ts src/lib/components/icons/icon-paths.test.ts src/lib/components/GenericToolRow.test.ts src/lib/components/ToolCallRow.test.ts` (62 tests), `pnpm --filter @loombox/providers-core typecheck`, `pnpm --filter @loombox/web typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.
