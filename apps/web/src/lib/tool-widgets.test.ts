import { describe, expect, it } from 'vitest';
import type { TranscriptToolCallItem } from '@loombox/providers-core';
import {
  bashCommand,
  isTodoInput,
  resolveToolWidgetKind,
  toolCallOutputText,
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
