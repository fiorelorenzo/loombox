import type { AcpToolCallUpdate } from '@loombox/providers-core';

/**
 * The Codex tool names with a bespoke tier-1 widget (SPEC.md §7.24: "Codex's
 * patch/diff/bash" bullet). The actual widget components live in `apps/web`
 * (out of scope for this package — see AGENTS.md's package boundaries); this
 * module supplies the data-level contract a UI needs to (a) route a tool
 * call to its bespoke widget and (b) suppress the generic `ToolKind`-
 * fallback row for the same call so streaming never briefly double-renders
 * it, mirroring `@loombox/providers-claude`'s `tool-widgets.ts`.
 *
 * Real Codex / codex-acp tool-call titles aren't confirmed offline in this
 * environment (no real binary) — matched as a case-insensitive *prefix*,
 * same working assumption as the Claude adapter (a real title reads like
 * `"Patch(src/foo.ts)"` rather than the bare tool name). Revisit against the
 * real binary once a build-time verification spike runs it.
 */
const BESPOKE_TOOL_NAME_PREFIXES = ['patch', 'diff', 'bash'] as const;

export type CodexBespokeToolName = 'patch' | 'diff' | 'bash';

/**
 * The bespoke tool name a tool call's `title` matches, if any — `undefined`
 * for a call with no title, or one that doesn't match a known Codex
 * bespoke-widget tool (which should render through the generic `ToolKind`
 * fallback row instead).
 */
export function codexBespokeToolName(
  update: Pick<AcpToolCallUpdate, 'title'>,
): CodexBespokeToolName | undefined {
  const title = update.title?.trim().toLowerCase();
  if (!title) return undefined;
  return BESPOKE_TOOL_NAME_PREFIXES.find((prefix) => title.startsWith(prefix));
}

/** True when this tool call should route to a bespoke widget rather than the generic fallback row. */
export function hasCodexBespokeWidget(update: Pick<AcpToolCallUpdate, 'title'>): boolean {
  return codexBespokeToolName(update) !== undefined;
}
