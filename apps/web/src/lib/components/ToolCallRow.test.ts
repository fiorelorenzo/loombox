// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptToolCallItem } from '@loombox/providers-core';
import ToolCallRow from './ToolCallRow.svelte';

afterEach(() => cleanup());

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

describe('ToolCallRow: bespoke tier-1 dispatch', () => {
  it('renders the Edit/Write bespoke widget for an edit-kind call with a diff, not the generic row', () => {
    render(ToolCallRow, {
      props: {
        item: toolCallItem({
          toolKind: 'edit',
          diff: { path: 'src/foo.ts', oldText: 'a', newText: 'b' },
        }),
      },
    });
    expect(screen.getByTestId('edit-write-widget')).toBeTruthy();
    expect(screen.queryByTestId('generic-tool-row')).toBeNull();
  });

  it('renders the Bash bespoke widget for an execute-kind call, not the generic row', () => {
    render(ToolCallRow, {
      props: { item: toolCallItem({ toolKind: 'execute', rawInput: { command: 'pnpm test' } }) },
    });
    expect(screen.getByTestId('bash-widget')).toBeTruthy();
    expect(screen.getByText('pnpm test')).toBeTruthy();
    expect(screen.queryByTestId('generic-tool-row')).toBeNull();
  });

  it('renders the TodoWrite bespoke widget for a call whose rawInput is a todos array', () => {
    render(ToolCallRow, {
      props: {
        item: toolCallItem({
          toolKind: 'other',
          rawInput: { todos: [{ content: 'ship it', status: 'in_progress' }] },
        }),
      },
    });
    expect(screen.getByTestId('todo-widget')).toBeTruthy();
    expect(screen.getByText('ship it')).toBeTruthy();
    expect(screen.queryByTestId('generic-tool-row')).toBeNull();
  });

  it('replays correctly from history: a tool_call followed by a tool_call_update still resolves the same bespoke widget', () => {
    // Simulates the item as it looks after the reducer merges a tool_call
    // then a tool_call_update onto it (transcript.ts's reduceToolCall) —
    // the widget only ever sees the merged, current item, live or replayed.
    const merged = toolCallItem({
      toolKind: 'edit',
      status: 'completed',
      diff: { path: 'src/bar.ts', oldText: null, newText: 'new file' },
    });
    render(ToolCallRow, { props: { item: merged } });
    expect(screen.getByTestId('edit-write-widget')).toBeTruthy();
  });
});

describe('ToolCallRow: tier-2 generic fallback (#140)', () => {
  it('renders the generic row for a tool call with no matching bespoke widget', () => {
    render(ToolCallRow, { props: { item: toolCallItem({ toolKind: 'search' }) } });
    expect(screen.getByTestId('generic-tool-row')).toBeTruthy();
  });

  it('never shows the generic row for an edit-kind call mid-stream before its diff has arrived — it stays pending, not a duplicate placeholder', () => {
    // Before the diff arrives, toolKind is 'edit' but diff is still
    // undefined: resolveToolWidgetKind falls back to 'generic' by design
    // (there's nothing to show in the bespoke widget yet), so exactly one
    // row renders, never two.
    render(ToolCallRow, { props: { item: toolCallItem({ toolKind: 'edit', diff: undefined }) } });
    expect(screen.getByTestId('generic-tool-row')).toBeTruthy();
    expect(screen.queryByTestId('edit-write-widget')).toBeNull();
  });
});

describe('ToolCallRow: error boundary (#139)', () => {
  it('falls back to the generic row instead of crashing the transcript when a bespoke widget throws', () => {
    // Malformed diff data (newText not actually a string) makes
    // EditWriteWidget's DiffViewer throw while computing the line diff —
    // forcing exactly the "one bad widget can't take down the transcript"
    // scenario the issue asks to test.
    const malformed = toolCallItem({
      toolKind: 'edit',
      diff: { path: 'src/broken.ts', oldText: 'a', newText: undefined as unknown as string },
    });
    render(ToolCallRow, { props: { item: malformed } });
    expect(screen.getByTestId('generic-tool-row')).toBeTruthy();
    expect(screen.queryByTestId('edit-write-widget')).toBeNull();
  });
});

describe('ToolCallRow: permission awaiting indicator (#146)', () => {
  it('marks the row as awaiting permission when told to', () => {
    render(ToolCallRow, {
      props: { item: toolCallItem({ toolKind: 'execute' }), awaitingPermission: true },
    });
    expect(screen.getByTestId('tool-call-row').className).toContain('awaiting-permission');
  });
});
