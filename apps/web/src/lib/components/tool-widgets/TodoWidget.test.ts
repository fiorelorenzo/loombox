// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
import TodoWidget from './TodoWidget.svelte';

afterEach(() => cleanup());

function todoItem(extra: Partial<TranscriptToolCallItem> = {}): TranscriptToolCallItem {
  return {
    type: 'tool_call',
    id: 'tc1',
    turnId: 't1',
    title: 'Todo list',
    toolKind: 'other',
    status: 'completed',
    diff: undefined,
    rawInput: { todos: [{ content: 'ship it', status: 'in_progress' }] },
    content: undefined,
    parentToolCallId: undefined,
    ...extra,
  };
}

describe('TodoWidget', () => {
  it('renders the checklist entries', () => {
    render(TodoWidget, { props: { item: todoItem() } });
    expect(screen.getByText('ship it')).toBeTruthy();
  });

  it('is expandable/collapsible, defaulting open', async () => {
    render(TodoWidget, { props: { item: todoItem() } });
    expect(screen.getByText('ship it')).toBeTruthy();
    const toggle = screen.getByRole('button', { expanded: true });
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('ship it')).toBeNull();
  });
});

describe('TodoWidget: shared tool-card treatment (issue #575, superseding v5 §4)', () => {
  it('states its role via the gutter icon alone now — no visible "Tool" word — and renders its content through the shared flat ToolCard', () => {
    const { container } = render(TodoWidget, { props: { item: todoItem() } });
    expect(screen.queryByText('Tool')).toBeNull();
    expect(container.querySelector('[data-icon-name="tool-generic"]')).toBeTruthy();
    expect(container.querySelector('.tool-card')).toBeTruthy();
  });
});
