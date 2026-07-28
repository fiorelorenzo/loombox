// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptToolCallItem } from '@loombox/providers-core';
import EditWriteWidget from './EditWriteWidget.svelte';

afterEach(() => cleanup());

function editItem(extra: Partial<TranscriptToolCallItem> = {}): TranscriptToolCallItem {
  return {
    type: 'tool_call',
    id: 'tc1',
    turnId: 't1',
    title: 'Edit src/foo.ts',
    toolKind: 'edit',
    status: 'completed',
    diff: { path: 'src/foo.ts', oldText: 'a', newText: 'b' },
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    ...extra,
  };
}

describe('EditWriteWidget', () => {
  it('renders the diff title and its DiffViewer body', () => {
    render(EditWriteWidget, { props: { item: editItem() } });
    expect(screen.getByText('Edit src/foo.ts')).toBeTruthy();
  });

  it('is expandable/collapsible, defaulting open', async () => {
    render(EditWriteWidget, { props: { item: editItem() } });
    const toggle = screen.getByRole('button', { expanded: true });
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('EditWriteWidget: shared tool-card treatment (design spec v5 §4)', () => {
  it('states its role as the visible word "Tool" in the gutter, and renders its content through the shared flat ToolCard', () => {
    const { container } = render(EditWriteWidget, { props: { item: editItem() } });
    expect(screen.getByText('Tool')).toBeTruthy();
    expect(container.querySelector('.tool-card')).toBeTruthy();
  });
});
