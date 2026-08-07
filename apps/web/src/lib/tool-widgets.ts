import type {
  AcpToolCallStatus,
  AcpToolKind,
  TranscriptToolCallItem,
} from '@loombox/providers-core/browser';
import { type StatusTone } from '$lib/components/ui/StatusDot.svelte';
import type { IconName } from '$lib/components/icons/icon-paths';

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

/**
 * The per-`ToolKind` glyph a tool-call row's `ToolCallGutter` draws (issue
 * #744, decisions doc C3-3): every kind ACP's wire schema enumerates
 * (`packages/providers/core/src/acp-wire-schema.ts`) gets its own icon now
 * instead of `search`/`read`/`fetch`/`delete`/`move` all sharing the
 * `tool-generic` wrench. `edit` and `execute` reuse the glyphs their own
 * bespoke widgets (`EditWriteWidget`/`BashWidget`) already draw, so a call
 * that resolves to `GenericToolRow` (mid-stream, before the bespoke
 * widget's data has arrived) still shows the SAME icon that widget will
 * draw once it takes over — no icon swap at the hand-off.
 *
 * `undefined` and `'other'` — plus, via the `default` branch, any future
 * `AcpToolKind` this switch doesn't know about yet — all fall back to
 * `tool-generic`, so an unrecognized future kind degrades gracefully
 * rather than rendering nothing (issue #744's acceptance bullet).
 */
export function toolKindIcon(toolKind: AcpToolKind | undefined): IconName {
  switch (toolKind) {
    case 'edit':
      return 'tool-edit';
    case 'execute':
      return 'tool-bash';
    case 'read':
      return 'tool-read';
    case 'delete':
      return 'tool-delete';
    case 'move':
      return 'tool-move';
    case 'search':
      return 'tool-search';
    case 'think':
      return 'tool-think';
    case 'fetch':
      return 'tool-fetch';
    case 'switch_mode':
      return 'tool-switch-mode';
    case 'other':
    case undefined:
    default:
      return 'tool-generic';
  }
}

/**
 * `TranscriptToolCallItem.elapsedMs` formatted for a one-line row: whole
 * milliseconds under a second (`"420ms"`), one decimal of seconds under a
 * minute (`"3.2s"`), otherwise minutes plus zero-padded seconds
 * (`"1m 04s"`) — issue #744. The caller only invokes this when `elapsedMs`
 * is already known; there is no "unknown" rendering here, see
 * `TranscriptToolCallItem.elapsedMs`'s own doc comment for when it's
 * `undefined` instead of calling this at all.
 */
export function formatToolCallElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * `TranscriptToolCallItem.attributedCostUsd` formatted for a one-line row
 * (issue #744): two decimal places down to a cent, four below it — plain
 * `toFixed(2)` would round every sub-cent figure (the common case for a
 * single tool call) to the misleading `"$0.00"`, indistinguishable from
 * the "nothing to attribute" case this whole heuristic exists to keep
 * honest. Same "only called once the value is known" contract as
 * `formatToolCallElapsed`.
 */
export function formatAttributedCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
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

/**
 * A tool call's textual output, extracted from the real ACP wire shape.
 *
 * `content` is an ARRAY of `ToolCallContent` entries, not a string. The
 * client passes it through verbatim (`providers-core/src/client.ts:297`,
 * `:657`) and only ever reaches into it for the diff case
 * (`extractDiff`, `:248`, added by the #623 wire audit) — so every text
 * case landed here and fell through to `JSON.stringify`, printing the
 * envelope instead of the output. A failed `pnpm typecheck` rendered as
 * `[{"type":"content","content":{"type":"text","text":"..."}}]`, which is
 * exactly the case the v7 C2-1 decision exists to make readable.
 *
 * Nothing caught it because no fixture ever sends a tool call WITH
 * content: `echo-acp-agent.mjs` only emits message chunks, and every e2e
 * tool call omits the field. See issue #689.
 *
 * Handled entries, per the ACP schema:
 * - `{ type: 'content', content: { type: 'text', text } }` — the common one.
 * - `{ type: 'content', content: { type: 'resource', resource: { text } } }`.
 * - a bare `{ type: 'text', text }`, which some agents emit unwrapped.
 * - `{ type: 'terminal', terminalId }` — no inline text to show; skipped.
 *
 * A genuinely unrecognised shape still falls back to `JSON.stringify`
 * rather than silently rendering nothing: showing an ugly blob beats
 * dropping a failure's only explanation.
 */
export function toolCallOutputText(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;

  const entries = Array.isArray(content) ? content : [content];
  const parts: string[] = [];
  let sawUnknown = false;

  for (const entry of entries) {
    const text = entryText(entry);
    if (text === undefined) sawUnknown = true;
    else if (text !== '') parts.push(text);
  }

  if (parts.length > 0) return parts.join('\n');
  return sawUnknown ? JSON.stringify(content, null, 2) : '';
}

/** One `ToolCallContent` entry's text: `''` when it carries none by design (a terminal reference), `undefined` when the shape is unrecognised. */
function entryText(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object' || entry === null) return undefined;

  const outer = entry as { type?: unknown; text?: unknown; content?: unknown };
  if (outer.type === 'text' && typeof outer.text === 'string') return outer.text;
  if (outer.type === 'terminal') return '';
  if (outer.type === 'diff') return '';
  if (outer.type !== 'content' && outer.content === undefined) return undefined;

  const inner = outer.content as { type?: unknown; text?: unknown; resource?: unknown } | undefined;
  if (typeof inner === 'string') return inner;
  if (typeof inner !== 'object' || inner === null) return undefined;
  if (inner.type === 'text' && typeof inner.text === 'string') return inner.text;

  const resource = inner.resource as { text?: unknown } | undefined;
  if (typeof resource?.text === 'string') return resource.text;
  return undefined;
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
