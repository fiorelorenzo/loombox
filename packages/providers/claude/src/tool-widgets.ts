import type { AcpToolCallUpdate } from '@loombox/providers-core';

/**
 * The Claude Code tool names with a bespoke tier-1 widget (SPEC.md §7.24:
 * "Claude's Edit/Write/Bash/TodoWrite" bullet). The actual widget components
 * live in `apps/web` (out of scope for this package — see AGENTS.md's
 * package boundaries); this module supplies the data-level contract a UI
 * needs to (a) route a tool call to its bespoke widget and (b) suppress the
 * generic `ToolKind`-fallback row for the same call so streaming never
 * briefly double-renders it (issue #184's "suppressed from the generic
 * ToolKind fallback... no duplicate rendering during streaming" bullet).
 *
 * Real Claude Code / claude-agent-acp tool-call titles aren't confirmed
 * offline in this environment (no real binary, §16's "verify at build
 * time" caveat) — matched as a case-insensitive *prefix*, on the working
 * assumption a real title reads like `"Edit(src/foo.ts)"` rather than the
 * bare tool name, so a literal-equality match would silently stop matching
 * anything. Revisit against the real binary in issue #54.
 */
const BESPOKE_TOOL_NAME_PREFIXES = ['edit', 'write', 'bash', 'todowrite'] as const;

export type ClaudeBespokeToolName = 'edit' | 'write' | 'bash' | 'todowrite';

/**
 * The bespoke tool name a tool call's `title` matches, if any — `undefined`
 * for a call with no title, or one that doesn't match a known Claude
 * bespoke-widget tool (which should render through the generic `ToolKind`
 * fallback row instead).
 */
export function claudeBespokeToolName(
  update: Pick<AcpToolCallUpdate, 'title'>,
): ClaudeBespokeToolName | undefined {
  const title = update.title?.trim().toLowerCase();
  if (!title) return undefined;
  return BESPOKE_TOOL_NAME_PREFIXES.find((prefix) => title.startsWith(prefix));
}

/** True when this tool call should route to a bespoke widget rather than the generic fallback row. */
export function hasClaudeBespokeWidget(update: Pick<AcpToolCallUpdate, 'title'>): boolean {
  return claudeBespokeToolName(update) !== undefined;
}
