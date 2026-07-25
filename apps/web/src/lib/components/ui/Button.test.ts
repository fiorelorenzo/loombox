// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Button from './Button.svelte';

afterEach(() => cleanup());

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
  }));
}

describe('Button (issue #428 Warp Deck shared UI primitives)', () => {
  it('renders its children and defaults to the primary variant/medium size', () => {
    render(Button, { props: { children: textSnippet('Create session') } });
    const button = screen.getByTestId('ui-button');
    expect(button.textContent).toContain('Create session');
    expect(button.getAttribute('data-variant')).toBe('primary');
    expect(button.getAttribute('data-size')).toBe('md');
    expect(button.getAttribute('type')).toBe('button');
  });

  it('applies each variant and size', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      cleanup();
      render(Button, { props: { children: textSnippet(variant), variant } });
      const button = screen.getByTestId('ui-button');
      expect(button.getAttribute('data-variant')).toBe(variant);
      expect(button.classList.contains(`ui-button-${variant}`)).toBe(true);
    }

    cleanup();
    render(Button, { props: { children: textSnippet('Small'), size: 'sm' } });
    expect(screen.getByTestId('ui-button').getAttribute('data-size')).toBe('sm');
  });

  it('fires onclick when enabled', async () => {
    const onclick = vi.fn();
    render(Button, { props: { children: textSnippet('Go'), onclick } });
    await fireEvent.click(screen.getByTestId('ui-button'));
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it('is disabled via the disabled prop', () => {
    const onclick = vi.fn();
    render(Button, { props: { children: textSnippet('Go'), onclick, disabled: true } });
    const button = screen.getByTestId('ui-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('loading shows the woven-thread motif and disables the button (issue #274)', () => {
    render(Button, { props: { children: textSnippet('Create session'), loading: true } });
    const button = screen.getByTestId('ui-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('woven-loader')).toBeTruthy();
  });

  it('supports an explicit ariaLabel override for non-text content', () => {
    render(Button, { props: { children: textSnippet('×'), ariaLabel: 'Close' } });
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('supports a submit type for form usage', () => {
    render(Button, { props: { children: textSnippet('Create'), type: 'submit' } });
    expect(screen.getByTestId('ui-button').getAttribute('type')).toBe('submit');
  });

  it('merges a caller-provided class onto the root element', () => {
    render(Button, { props: { children: textSnippet('Go'), class: 'my-extra' } });
    expect(screen.getByTestId('ui-button').classList.contains('my-extra')).toBe(true);
  });
});
