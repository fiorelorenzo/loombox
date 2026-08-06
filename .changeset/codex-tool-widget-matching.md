---
'@loombox/providers-codex': patch
---

Fix Codex bespoke tool-widget matching against real tool-call titles (issue #819)

`codexBespokeToolName`/`hasCodexBespokeWidget` (`packages/providers/codex/src/tool-widgets.ts`) matched a tool call's `title` against a case-insensitive `'patch'`/`'diff'`/`'bash'` prefix — an assumption issue #182's build-time verification spike (`docs/research/codex-acp-completeness.md` §3) proved no real Codex tool call ever satisfies, so these functions never fired for a real Codex session and every Codex tool call fell through to the generic row.

Matched structurally against the real wire shape instead:

- A file-change tool call is always titled literally `"Editing files"` with `toolKind: 'edit'` — never `"Patch(...)"`/`"Diff(...)"`. Codex has no separate patch vs. diff tool call, so both collapse into one `'edit'` bespoke name (`CodexBespokeToolName` is now `'edit' | 'bash'`, was `'patch' | 'diff' | 'bash'`).
- A shell-command tool call's title is the arbitrary command text itself, its `bash`/`zsh`/`sh` prefix already stripped before the title is built — title text can never identify it. Matched by `toolKind: 'execute'` alone, mirroring `apps/web`'s already-fixed `resolveToolWidgetKind` (issue #623), which routes the same way for the same reason.

Both functions now read `toolKind` in addition to `title` (their `Pick<AcpToolCallUpdate, ...>` parameter grew accordingly).

The same class of bug (an unconfirmed title-prefix guess) still exists in `@loombox/providers-claude`'s `claudeBespokeToolName`/`hasClaudeBespokeWidget` — its own doc comment already tracks this as issue #54; deliberately left untouched here, a Codex-only fix.

Verified: `pnpm --filter @loombox/providers-codex exec vitest run` (42 passed; 1 pre-existing failure in `codex-acp-capabilities.test.ts`'s `buildCodexImageContentBlock`/`InlineImageHandoffResult` mimeType assertion, unrelated to this change and reproduced identically on a clean `origin/main` checkout before any of this PR's edits), `pnpm --filter @loombox/providers-codex typecheck` (same single pre-existing failure, same line, reproduced pre-existing), `pnpm exec eslint` on every changed file (clean), and the full `pnpm format:check` (clean).
