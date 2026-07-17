import type { TranscriptToolCallItem } from '@loombox/providers-core';

/**
 * The tier-1 bespoke tool-call widget table (SPEC.md §7.24 "Tool calls, two
 * tiers in v1"; issue #139): Claude Code's Edit/Write/Bash/TodoWrite and
 * Codex's patch/diff/bash. `AcpToolCallUpdate` carries no raw "tool name"
 * field on the wire (only `toolKind` + a human `title` + structural
 * `rawInput`/`diff`), so bespoke selection here is keyed off structural
 * signals rather than a name string:
 *
 * - `'edit-write'` — Claude's Edit/Write and Codex's patch/diff all produce
 *   the same ACP v1 `Diff` shape; one widget (reusing the diff viewer,
 *   SPEC.md §7.24 "same component" note) covers all four.
 * - `'bash'` — any `execute`-kind tool call (Claude's Bash, Codex's bash).
 * - `'todo'` — Claude's TodoWrite: no ACP field distinguishes it from any
 *   other `other`-kind call, so it's keyed structurally on `rawInput`
 *   carrying a `todos: {content, status}[]` array, TodoWrite's own actual
 *   input shape.
 * - `'generic'` — the tier-2 `ToolKind`-driven fallback (issue #140).
 */
export type ToolWidgetKind = 'edit-write' | 'bash' | 'todo' | 'generic';

interface TodoInput {
  todos: Array<{ content: string; status: string }>;
}

export function isTodoInput(rawInput: unknown): rawInput is TodoInput {
  if (typeof rawInput !== 'object' || rawInput === null) return false;
  const todos = (rawInput as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return false;
  return todos.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { content?: unknown }).content === 'string' &&
      typeof (entry as { status?: unknown }).status === 'string',
  );
}

export function resolveToolWidgetKind(item: TranscriptToolCallItem): ToolWidgetKind {
  if (isTodoInput(item.rawInput)) return 'todo';
  if (item.toolKind === 'edit' && item.diff !== undefined) return 'edit-write';
  if (item.toolKind === 'execute') return 'bash';
  return 'generic';
}

/** Best-effort extraction of the shell command a Bash-kind tool call ran, for `BashWidget`. */
export function bashCommand(item: TranscriptToolCallItem): string {
  const rawInput = item.rawInput;
  if (typeof rawInput === 'object' && rawInput !== null) {
    const command = (rawInput as { command?: unknown }).command;
    if (typeof command === 'string') return command;
  }
  return item.title ?? '(command unknown)';
}

/** Best-effort extraction of a tool call's textual output/content, for a raw-content render. */
export function toolCallOutputText(content: unknown): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content, null, 2);
}
