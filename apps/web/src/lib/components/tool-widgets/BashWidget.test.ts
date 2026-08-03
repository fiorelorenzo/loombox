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
  it('renders the command and output through TerminalOutput', () => {
    render(BashWidget, { props: { item: bashItem() } });
    expect(screen.getByTestId('terminal-command').textContent).toBe('pnpm test');
    expect(screen.getByTestId('terminal-body').textContent).toBe('ok 12 passed');
  });

  it('is expandable/collapsible, defaulting open', async () => {
    render(BashWidget, { props: { item: bashItem() } });
    expect(screen.getByTestId('terminal-output')).toBeTruthy();

    const toggle = screen.getByRole('button', { expanded: true });
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('terminal-output')).toBeNull();
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
