// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import TerminalOutput from './TerminalOutput.svelte';

afterEach(() => cleanup());

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('TerminalOutput (#142)', () => {
  it('renders a command and its output, read-only, given a plain string', () => {
    render(TerminalOutput, {
      props: { command: 'pnpm test', content: 'ok 12 passed', status: 'completed' },
    });
    expect(screen.getByTestId('terminal-command').textContent).toBe('pnpm test');
    expect(screen.getByTestId('terminal-body').textContent).toBe('ok 12 passed');
    expect(screen.getByText('completed')).toBeTruthy();
    // Read-only: no input/textarea rendered anywhere in the component.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('decodes raw byte chunks through the same chunk-boundary-safe pipeline as $lib/terminal.ts', () => {
    render(TerminalOutput, {
      props: { content: [bytes('a\x1b[31m'), bytes('b\x1b[0mc')] },
    });
    expect(screen.getByTestId('terminal-body').textContent).toBe('abc');
  });

  it('renders correctly when a multi-byte UTF-8 sequence is split across chunks', () => {
    const full = bytes('emoji 😀 ok');
    const splitPoint = bytes('emoji ').length + 2; // mid-emoji split
    render(TerminalOutput, {
      props: { content: [full.slice(0, splitPoint), full.slice(splitPoint)] },
    });
    expect(screen.getByTestId('terminal-body').textContent).toBe('emoji 😀 ok');
  });

  it('omits the header row entirely when no command is given', () => {
    render(TerminalOutput, { props: { content: 'just output' } });
    expect(screen.queryByTestId('terminal-command')).toBeNull();
    expect(screen.getByTestId('terminal-body').textContent).toBe('just output');
  });
});
