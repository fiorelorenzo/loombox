// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
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
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
    ...extra,
  };
}

describe('EditWriteWidget', () => {
  it('renders the diff title', () => {
    render(EditWriteWidget, { props: { item: editItem() } });
    expect(screen.getByText('Edit src/foo.ts')).toBeTruthy();
  });

  it('stays expanded by default while a call is still running', () => {
    render(EditWriteWidget, { props: { item: editItem({ status: 'in_progress' }) } });
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
  });
});

describe('EditWriteWidget: resting state and its one override (v7 decisions §3, issue #668)', () => {
  it('C1-1 — a completed call rests collapsed to one line: title plus outcome on the header, diff behind the disclosure', () => {
    const { container } = render(EditWriteWidget, { props: { item: editItem() } });
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy();
    // `hidden`, never unmounted (see the file doc comment on why), but
    // still not part of the rendered layout at rest.
    expect(container.querySelector('.body')?.hasAttribute('hidden')).toBe(true);
  });

  it('expands on click, and collapses again on a second click', async () => {
    const { container } = render(EditWriteWidget, { props: { item: editItem() } });
    const toggle = screen.getByRole('button', { expanded: false });
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.body')?.hasAttribute('hidden')).toBe(false);

    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.body')?.hasAttribute('hidden')).toBe(true);
  });

  it('C2-1 — a failed call always renders in full, with no disclosure control to collapse it', () => {
    const { container } = render(EditWriteWidget, {
      props: { item: editItem({ status: 'failed' }) },
    });
    expect(container.querySelector('.body')?.hasAttribute('hidden')).toBe(false);
    const header = screen.getByTestId('row-header');
    expect(header.tagName).toBe('DIV');
    expect(header.getAttribute('aria-expanded')).toBeNull();
  });

  it('a malformed diff still throws into the error boundary even while collapsed at rest (issue #139 stays intact)', () => {
    // The DiffViewer body is `hidden`, never `{#if}`-removed, precisely so
    // this keeps working: it still mounts and computes its line diff the
    // instant the widget renders, regardless of the collapsed default.
    const malformed = editItem({
      diff: { path: 'src/broken.ts', oldText: 'a', newText: undefined as unknown as string },
    });
    expect(() => render(EditWriteWidget, { props: { item: malformed } })).toThrow();
  });
});

describe('EditWriteWidget: shared tool-card treatment (issue #575, superseding v5 §4)', () => {
  it('states its role via the gutter icon alone now — no visible "Tool" word — and renders its content through the shared flat ToolCard', () => {
    const { container } = render(EditWriteWidget, { props: { item: editItem() } });
    expect(screen.queryByText('Tool')).toBeNull();
    expect(container.querySelector('[data-icon-name="tool-edit"]')).toBeTruthy();
    expect(container.querySelector('.tool-card')).toBeTruthy();
  });
});
