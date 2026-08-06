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
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
    ...extra,
  };
}

describe('TodoWidget', () => {
  it('renders the checklist entries while a call is still running', () => {
    render(TodoWidget, { props: { item: todoItem({ status: 'in_progress' }) } });
    expect(screen.getByText('ship it')).toBeTruthy();
  });

  it('stays expanded by default while a call is still running', () => {
    render(TodoWidget, { props: { item: todoItem({ status: 'in_progress' }) } });
    const toggle = screen.getByRole('button', { expanded: true });
    expect(toggle).toBeTruthy();
  });
});

describe('TodoWidget: resting state and its one override (v7 decisions §3, issue #668)', () => {
  it('C1-1 — a completed call rests collapsed to one line: title plus a done/total progress summary, checklist behind the disclosure', () => {
    render(TodoWidget, { props: { item: todoItem() } });
    expect(screen.getByText('0/1 done')).toBeTruthy();
    expect(screen.queryByText('ship it')).toBeNull();
  });

  it('the collapsed rest state draws no border/background — only the expanded checklist keeps the card', () => {
    const { container } = render(TodoWidget, { props: { item: todoItem() } });
    expect(container.querySelector('.tool-card')?.getAttribute('data-surface')).toBe('false');
  });

  it('expands on click to show the full checklist and its card, and collapses again on a second click', async () => {
    const { container } = render(TodoWidget, { props: { item: todoItem() } });
    const toggle = screen.getByRole('button', { expanded: false });
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('ship it')).toBeTruthy();
    expect(container.querySelector('.tool-card')?.getAttribute('data-surface')).toBe('true');

    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('ship it')).toBeNull();
  });

  it('C2-1 — a failed call always renders the full checklist, with no disclosure control to collapse it', () => {
    render(TodoWidget, { props: { item: todoItem({ status: 'failed' }) } });
    expect(screen.getByText('ship it')).toBeTruthy();
    const header = screen.getByTestId('row-header');
    expect(header.tagName).toBe('DIV');
    expect(header.getAttribute('aria-expanded')).toBeNull();
  });
});

describe('TodoWidget: shared tool-card treatment (issue #575, superseding v5 §4)', () => {
  it('states its role via the gutter icon alone now — no visible "Tool" word — and renders its content through the shared flat ToolCard', () => {
    const { container } = render(TodoWidget, {
      props: { item: todoItem({ status: 'in_progress' }) },
    });
    expect(screen.queryByText('Tool')).toBeNull();
    expect(container.querySelector('[data-icon-name="tool-generic"]')).toBeTruthy();
    expect(container.querySelector('.tool-card')).toBeTruthy();
  });
});
