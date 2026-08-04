// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CopyButton from './CopyButton.svelte';

afterEach(() => cleanup());

describe('CopyButton', () => {
  it('renders an accessible button and calls the provided copy function with its text on click', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    render(CopyButton, { props: { text: 'hello world', label: 'Copy message', copyFn: copy } });

    const button = screen.getByRole('button', { name: 'Copy message' });
    await fireEvent.click(button);

    expect(copy).toHaveBeenCalledWith('hello world');
  });

  it('stays permanently visible (dim, not hidden) by default — only opts into row-scoped hover reveal via revealOnHover (redesign v3 §3.4)', () => {
    render(CopyButton, { props: { text: 'x', label: 'Copy x' } });
    const button = screen.getByRole('button', { name: 'Copy x' });
    expect(button.className).toContain('copy-button');
    expect(button.className).not.toContain('copy-button-reveal');
  });

  it('opts into the row-scoped hover-reveal modifier class when revealOnHover is set', () => {
    render(CopyButton, { props: { text: 'x', label: 'Copy x', revealOnHover: true } });
    const button = screen.getByRole('button', { name: 'Copy x' });
    expect(button.className).toContain('copy-button-reveal');
  });

  it('drops the dim resting state for a standalone call site (prominent)', () => {
    render(CopyButton, { props: { text: 'x', label: 'Copy x', prominent: true } });
    const button = screen.getByRole('button', { name: 'Copy x' });
    // The 0.5 resting opacity earns its keep on a copy icon that repeats on
    // every transcript row. On a lone standalone copy button (e.g.
    // GithubConnectFlow's device code) it read as disabled next to
    // full-strength neighbours.
    expect(button.className).toContain('copy-button-prominent');
    expect(button.className).not.toContain('copy-button-reveal');
  });
});
