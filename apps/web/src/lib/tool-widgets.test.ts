import { describe, expect, it } from 'vitest';
import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
import {
  bashCommand,
  classifyRawInput,
  isTodoInput,
  resolveToolWidgetKind,
  toolCallOutputText,
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
