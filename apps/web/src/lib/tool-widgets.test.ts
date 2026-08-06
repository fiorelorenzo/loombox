import { describe, expect, it } from 'vitest';
import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
import {
  bashCommand,
  classifyRawInput,
  formatAttributedCost,
  formatToolCallElapsed,
  isTodoInput,
  resolveToolWidgetKind,
  toolCallOutputText,
  toolKindIcon,
  TOOL_CALL_STATUS_LABELS,
  TOOL_CALL_STATUS_TONES,
} from './tool-widgets';

function toolCallItem(extra: Partial<TranscriptToolCallItem> = {}): TranscriptToolCallItem {
  return {
    type: 'tool_call',
    id: 'tc1',
    turnId: 't1',
    title: 'a tool call',
    toolKind: undefined,
    status: 'completed',
    diff: undefined,
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
    ...extra,
  };
}

describe('resolveToolWidgetKind', () => {
  it('resolves an edit-kind call with a diff to edit-write (Claude Edit/Write, Codex patch/diff)', () => {
    const item = toolCallItem({
      toolKind: 'edit',
      diff: { path: 'a.ts', oldText: 'x', newText: 'y' },
    });
    expect(resolveToolWidgetKind(item)).toBe('edit-write');
  });

  it('resolves an execute-kind call to bash (Claude Bash, Codex bash)', () => {
    const item = toolCallItem({ toolKind: 'execute' });
    expect(resolveToolWidgetKind(item)).toBe('bash');
  });

  it('resolves a call whose rawInput is a todos array to todo (Claude TodoWrite)', () => {
    const item = toolCallItem({
      toolKind: 'other',
      rawInput: { todos: [{ content: 'do a thing', status: 'pending' }] },
    });
    expect(resolveToolWidgetKind(item)).toBe('todo');
  });

  it('falls back to generic for an edit-kind call with no diff yet (mid-stream, before the bespoke widget has data)', () => {
    const item = toolCallItem({ toolKind: 'edit' });
    expect(resolveToolWidgetKind(item)).toBe('generic');
  });

  it('falls back to generic for anything else (read/search/other with no todos)', () => {
    expect(resolveToolWidgetKind(toolCallItem({ toolKind: 'read' }))).toBe('generic');
    expect(resolveToolWidgetKind(toolCallItem({ toolKind: 'search' }))).toBe('generic');
    expect(resolveToolWidgetKind(toolCallItem({ toolKind: undefined }))).toBe('generic');
  });
});

describe('toolKindIcon', () => {
  it('maps every ACP tool kind to its own distinct glyph', () => {
    const cases: Array<[TranscriptToolCallItem['toolKind'], string]> = [
      ['read', 'tool-read'],
      ['edit', 'tool-edit'],
      ['delete', 'tool-delete'],
      ['move', 'tool-move'],
      ['search', 'tool-search'],
      ['execute', 'tool-bash'],
      ['think', 'tool-think'],
      ['fetch', 'tool-fetch'],
      ['other', 'tool-generic'],
    ];
    const seen = new Set<string>();
    for (const [toolKind, expected] of cases) {
      expect(toolKindIcon(toolKind)).toBe(expected);
      seen.add(expected);
    }
    // Every mapped icon in the table above is unique — no two kinds share
    // a glyph (the exact defect issue #744 fixes).
    expect(seen.size).toBe(cases.length);
  });

  it('falls back to tool-generic for undefined and for an unrecognized future kind, rather than throwing', () => {
    expect(toolKindIcon(undefined)).toBe('tool-generic');
    expect(toolKindIcon('made-up-future-kind' as TranscriptToolCallItem['toolKind'])).toBe(
      'tool-generic',
    );
  });
});

describe('formatToolCallElapsed', () => {
  it('renders sub-second durations in whole milliseconds', () => {
    expect(formatToolCallElapsed(0)).toBe('0ms');
    expect(formatToolCallElapsed(420)).toBe('420ms');
    expect(formatToolCallElapsed(999)).toBe('999ms');
  });

  it('renders sub-minute durations in seconds with one decimal', () => {
    expect(formatToolCallElapsed(1000)).toBe('1.0s');
    expect(formatToolCallElapsed(3200)).toBe('3.2s');
    expect(formatToolCallElapsed(59_900)).toBe('59.9s');
  });

  it('renders minute-plus durations as minutes and zero-padded seconds', () => {
    expect(formatToolCallElapsed(60_000)).toBe('1m 00s');
    expect(formatToolCallElapsed(64_000)).toBe('1m 04s');
    expect(formatToolCallElapsed(125_000)).toBe('2m 05s');
  });
});

describe('formatAttributedCost', () => {
  it('renders a cent or more with two decimal places', () => {
    expect(formatAttributedCost(0.04)).toBe('$0.04');
    expect(formatAttributedCost(1.5)).toBe('$1.50');
  });

  it('renders a sub-cent figure with four decimal places instead of rounding it to the misleading $0.00', () => {
    expect(formatAttributedCost(0.0032)).toBe('$0.0032');
    expect(formatAttributedCost(0.0001)).toBe('$0.0001');
  });
});

describe('isTodoInput', () => {
  it('rejects non-object, null, and malformed shapes', () => {
    expect(isTodoInput(undefined)).toBe(false);
    expect(isTodoInput(null)).toBe(false);
    expect(isTodoInput('todos')).toBe(false);
    expect(isTodoInput({ todos: 'not-an-array' })).toBe(false);
    expect(isTodoInput({ todos: [{ content: 1, status: 'pending' }] })).toBe(false);
  });
});

describe('bashCommand', () => {
  it('reads rawInput.command when present', () => {
    expect(bashCommand(toolCallItem({ rawInput: { command: 'ls -la' } }))).toBe('ls -la');
  });

  it('falls back to the title when rawInput has no command field', () => {
    expect(bashCommand(toolCallItem({ title: 'Bash: pnpm test', rawInput: {} }))).toBe(
      'Bash: pnpm test',
    );
  });
});

describe('toolCallOutputText', () => {
  it('passes a string through unchanged', () => {
    expect(toolCallOutputText('raw output')).toBe('raw output');
  });

  it('stringifies a non-string content payload', () => {
    expect(toolCallOutputText({ exitCode: 0 })).toBe('{\n  "exitCode": 0\n}');
  });

  // Issue #689: `content` on the ACP wire is an ARRAY of `ToolCallContent`,
  // and every one of these used to render as a `JSON.stringify` envelope.
  it('extracts text from the ACP content array, the real wire shape', () => {
    expect(
      toolCallOutputText([
        { type: 'content', content: { type: 'text', text: 'src/a.ts(4,9): error TS2304' } },
      ]),
    ).toBe('src/a.ts(4,9): error TS2304');
  });

  it('joins several content entries in order', () => {
    expect(
      toolCallOutputText([
        { type: 'content', content: { type: 'text', text: 'first' } },
        { type: 'content', content: { type: 'text', text: 'second' } },
      ]),
    ).toBe('first\nsecond');
  });

  it('reads a resource entry through to its own text', () => {
    expect(
      toolCallOutputText([
        { type: 'content', content: { type: 'resource', resource: { text: 'file body' } } },
      ]),
    ).toBe('file body');
  });

  it('accepts a bare text block, which some agents emit unwrapped', () => {
    expect(toolCallOutputText([{ type: 'text', text: 'bare' }])).toBe('bare');
  });

  it('renders nothing for a terminal reference, which carries no inline text', () => {
    expect(toolCallOutputText([{ type: 'terminal', terminalId: 't1' }])).toBe('');
  });

  it('keeps the text when a diff entry sits beside it, rather than dropping both', () => {
    expect(
      toolCallOutputText([
        { type: 'diff', path: '/a.ts', oldText: 'a', newText: 'b' },
        { type: 'content', content: { type: 'text', text: 'applied' } },
      ]),
    ).toBe('applied');
  });

  it('still stringifies a genuinely unrecognised shape, rather than swallowing it', () => {
    expect(toolCallOutputText([{ type: 'something-new', payload: 1 }])).toContain('something-new');
  });

  it('returns "" for undefined content', () => {
    expect(toolCallOutputText(undefined)).toBe('');
  });
});

describe('classifyRawInput', () => {
  it('classifies a command field as a command line', () => {
    expect(classifyRawInput({ command: 'pnpm test' })).toEqual({
      kind: 'command',
      command: 'pnpm test',
    });
  });

  it('classifies a lone string as a command line', () => {
    expect(classifyRawInput('ls -la')).toEqual({ kind: 'command', command: 'ls -la' });
  });

  it('classifies a single path-like field as a path', () => {
    expect(classifyRawInput({ path: 'src/foo.ts' })).toEqual({
      kind: 'path',
      path: 'src/foo.ts',
    });
  });

  it('falls back to a formatted key/value entry list for an unrecognised object, never a JSON blob', () => {
    const result = classifyRawInput({ pattern: 'TODO' });
    expect(result).toEqual({ kind: 'entries', entries: [{ key: 'pattern', value: 'TODO' }] });
    expect(JSON.stringify(result)).not.toContain('{\\"');
  });

  it('formats every entry value, never leaving a nested object as a raw JSON string the caller has to parse back out', () => {
    const result = classifyRawInput({ recursive: true, maxDepth: 2 });
    expect(result).toEqual({
      kind: 'entries',
      entries: [
        { key: 'recursive', value: 'true' },
        { key: 'maxDepth', value: '2' },
      ],
    });
  });

  it('returns undefined for an empty object, an empty string, undefined, or null', () => {
    expect(classifyRawInput({})).toBeUndefined();
    expect(classifyRawInput('')).toBeUndefined();
    expect(classifyRawInput(undefined)).toBeUndefined();
    expect(classifyRawInput(null)).toBeUndefined();
  });
});

describe('TOOL_CALL_STATUS_TONES / TOOL_CALL_STATUS_LABELS', () => {
  it('maps every AcpToolCallStatus onto the StatusTone vocabulary with a human label, never the raw enum', () => {
    const statuses: Array<keyof typeof TOOL_CALL_STATUS_TONES> = [
      'pending',
      'in_progress',
      'completed',
      'failed',
    ];
    for (const status of statuses) {
      expect(TOOL_CALL_STATUS_TONES[status]).toBeTruthy();
      expect(TOOL_CALL_STATUS_LABELS[status]).toBeTruthy();
      expect(TOOL_CALL_STATUS_LABELS[status]).not.toBe(status);
    }
    expect(TOOL_CALL_STATUS_TONES.completed).toBe('success');
    expect(TOOL_CALL_STATUS_TONES.failed).toBe('danger');
    expect(TOOL_CALL_STATUS_TONES.in_progress).toBe('info');
    expect(TOOL_CALL_STATUS_TONES.pending).toBe('neutral');
  });
});
