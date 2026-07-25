import type { AcpToolCallStatus, TranscriptToolCallItem } from '@loombox/providers-core';
import { type StatusTone } from '$lib/components/ui/StatusDot.svelte';

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

/** One key/value row of a formatted `rawInput` fallback (see {@link classifyRawInput}). */
export interface RawInputEntry {
  key: string;
  value: string;
}

/**
 * How an unrecognized tool call's `rawInput` renders (redesign v3 design
 * spec §2 `C7` / §3.4 "widget registry"): a `command` field renders as a
 * single mono command line, a lone `path`-like field renders as a path,
 * and anything else renders as a formatted key/value list — raw
 * `JSON.stringify` output is never shown. Shared by `PermissionCard` (the
 * composer-site approval card) and any transcript tool-call row that
 * falls through to a generic render, so both surfaces agree on one
 * classification instead of two.
 */
export type RawInputRender =
  | { kind: 'command'; command: string }
  | { kind: 'path'; path: string }
  | { kind: 'entries'; entries: RawInputEntry[] };

const RAW_INPUT_PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'uri'];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatRawInputValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}

export function classifyRawInput(rawInput: unknown): RawInputRender | undefined {
  if (typeof rawInput === 'string') {
    return rawInput.trim() === '' ? undefined : { kind: 'command', command: rawInput };
  }
  if (!isPlainRecord(rawInput)) return undefined;
  const entries = Object.entries(rawInput);
  if (entries.length === 0) return undefined;
  const command = rawInput.command;
  if (typeof command === 'string') return { kind: 'command', command };
  if (entries.length === 1) {
    const [key, value] = entries[0];
    if (RAW_INPUT_PATH_KEYS.includes(key) && typeof value === 'string') {
      return { kind: 'path', path: value };
    }
  }
  return {
    kind: 'entries',
    entries: entries.map(([key, value]) => ({ key, value: formatRawInputValue(value) })),
  };
}

/**
 * Maps a tool call's `AcpToolCallStatus` onto the shared `StatusDot` tone
 * vocabulary (redesign v3 design spec §3.4 "one tool-call anatomy": status
 * is a `StatusDot` + short label, never grey body text quoting the raw
 * enum — mirrors `$lib/session-status.ts`'s identical discipline for
 * session status).
 */
export const TOOL_CALL_STATUS_TONES: Record<AcpToolCallStatus, StatusTone> = {
  pending: 'neutral',
  in_progress: 'info',
  completed: 'success',
  failed: 'danger',
};

/** Short, human status wording for a tool call — never the raw enum. */
export const TOOL_CALL_STATUS_LABELS: Record<AcpToolCallStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
};
