import type { AcpToolCallUpdate } from '@loombox/providers-core';

/**
 * The Codex tool calls with a bespoke tier-1 widget (SPEC.md §7.24: "Codex's
 * patch/diff/bash" bullet). The actual widget components live in `apps/web`
 * (out of scope for this package — see AGENTS.md's package boundaries); this
 * module supplies the data-level contract a UI needs to (a) route a tool
 * call to its bespoke widget and (b) suppress the generic `ToolKind`-
 * fallback row for the same call so streaming never briefly double-renders
 * it, mirroring `@loombox/providers-claude`'s `tool-widgets.ts`.
 *
 * Matched structurally against the real Codex wire shape, per the build-time
 * verification spike (issue #182; `docs/research/codex-acp-completeness.md`
 * §3, "real, concrete gap" — filed as this fix, issue #819). The previous
 * version matched a case-insensitive `title` *prefix* against
 * `'patch'`/`'diff'`/`'bash'`, an assumption the spike found no real Codex
 * tool call ever satisfies:
 *
 * - A file-change tool call is always titled literally `"Editing files"`,
 *   `toolKind: 'edit'` (`CodexToolCallMapper.ts`'s `createFileChangeUpdate`)
 *   — never `"Patch(...)"`/`"Diff(...)"`. Codex has no separate patch vs.
 *   diff tool call; both collapse to this one `'edit'` bespoke name.
 * - A shell-command tool call's title IS the command text itself, with its
 *   `bash`/`zsh`/`sh` prefix already stripped before the title is built
 *   (`stripShellPrefix()`) — title text can never identify it. Matched by
 *   `toolKind: 'execute'` alone instead, mirroring `apps/web`'s own
 *   already-fixed `resolveToolWidgetKind` (`apps/web/src/lib/tool-widgets.ts`,
 *   issue #623), which routes the same way for the same reason.
 *
 * The same class of bug (an unconfirmed title-prefix guess) still exists in
 * `@loombox/providers-claude`'s `claudeBespokeToolName`/
 * `hasClaudeBespokeWidget` — its own doc comment already flags this and
 * tracks it as issue #54; deliberately left alone here (out of #819's
 * scope, a Codex-only fix).
 */
const EDIT_TOOL_CALL_TITLE = 'editing files';

export type CodexBespokeToolName = 'edit' | 'bash';

/**
 * The bespoke tool name a tool call matches, if any — `undefined` for a
 * call with no recognized signal (which should render through the generic
 * `ToolKind` fallback row instead).
 */
export function codexBespokeToolName(
  update: Pick<AcpToolCallUpdate, 'title' | 'toolKind'>,
): CodexBespokeToolName | undefined {
  if (update.toolKind === 'execute') return 'bash';
  if (update.toolKind === 'edit' && update.title?.trim().toLowerCase() === EDIT_TOOL_CALL_TITLE) {
    return 'edit';
  }
  return undefined;
}

/** True when this tool call should route to a bespoke widget rather than the generic fallback row. */
export function hasCodexBespokeWidget(
  update: Pick<AcpToolCallUpdate, 'title' | 'toolKind'>,
): boolean {
  return codexBespokeToolName(update) !== undefined;
}
