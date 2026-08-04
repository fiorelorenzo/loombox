// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
import BashWidget from './BashWidget.svelte';

afterEach(() => cleanup());

function bashItem(extra: Partial<TranscriptToolCallItem> = {}): TranscriptToolCallItem {
  return {
    type: 'tool_call',
    id: 'tc1',
    turnId: 't1',
    title: 'Bash',
    toolKind: 'execute',
    status: 'completed',
    diff: undefined,
    rawInput: { command: 'pnpm test' },
    content: 'ok 12 passed',
    parentToolCallId: undefined,
    ...extra,
  };
}

describe('BashWidget', () => {
  it('renders the command and output through TerminalOutput while still running', () => {
    render(BashWidget, { props: { item: bashItem({ status: 'in_progress' }) } });
    expect(screen.getByTestId('terminal-command').textContent).toBe('pnpm test');
    expect(screen.getByTestId('terminal-body').textContent).toBe('ok 12 passed');
  });

  it('stays expanded by default while a call is still running', () => {
    render(BashWidget, { props: { item: bashItem({ status: 'in_progress' }) } });
    expect(screen.getByTestId('terminal-output')).toBeTruthy();
  });
});

describe('BashWidget: resting state and its one override (v7 decisions §3, issue #668)', () => {
  it('C1-1 — a completed call rests collapsed to one line: the command and outcome on the header, output behind the disclosure', () => {
    render(BashWidget, { props: { item: bashItem() } });
    expect(screen.getByText('$ pnpm test')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Completed' })).toBeTruthy();
    expect(screen.queryByTestId('terminal-output')).toBeNull();
  });

  it('expands on click, and collapses again on a second click', async () => {
    render(BashWidget, { props: { item: bashItem() } });
    const toggle = screen.getByRole('button', { expanded: false });
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('terminal-output')).toBeTruthy();

    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('terminal-output')).toBeNull();
  });

  it('C2-1 — a failed call always renders in full, uncapped, with no disclosure control to collapse it', () => {
    render(BashWidget, { props: { item: bashItem({ status: 'failed' }) } });
    expect(screen.getByTestId('terminal-output')).toBeTruthy();
    expect(screen.getByTestId('terminal-body').textContent).toBe('ok 12 passed');
    // Locked open: the header renders as a plain, non-interactive div —
    // no disclosure button at all, so there is nothing to click by
    // accident that would hide the failure's output.
    const header = screen.getByTestId('row-header');
    expect(header.tagName).toBe('DIV');
    expect(header.getAttribute('aria-expanded')).toBeNull();
  });
});

describe('BashWidget: shared tool-card treatment (issue #575, superseding v5 §4)', () => {
  it('states its role via the gutter icon alone now — no visible "Tool" word — and renders its content through the shared flat ToolCard', () => {
    const { container } = render(BashWidget, { props: { item: bashItem() } });
    expect(screen.queryByText('Tool')).toBeNull();
    expect(container.querySelector('[data-icon-name="tool-bash"]')).toBeTruthy();
    expect(container.querySelector('.tool-card')).toBeTruthy();
  });
});
