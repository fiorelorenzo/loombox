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
    // Inheriting the label's colour, not the loader's accent default: on a
    // primary button that default IS the background, so the busy state rendered
    // accent-on-accent and nothing showed (measured on the sign-in gate).
    expect(screen.getByTestId('woven-loader').getAttribute('data-tone')).toBe('inherit');
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

  it('defaults data-testid to "ui-button" but lets a caller override it (issue #460)', () => {
    render(Button, { props: { children: textSnippet('Go') } });
    expect(screen.getByTestId('ui-button')).toBeTruthy();

    cleanup();
    render(Button, {
      props: { children: textSnippet('Save theme'), dataTestId: 'appearance-save-button' },
    });
    expect(screen.queryByTestId('ui-button')).toBeNull();
    const overridden = screen.getByTestId('appearance-save-button');
    expect(overridden.textContent).toContain('Save theme');
  });

  it('sets no aria-pressed at all unless it is really a toggle', () => {
    render(Button, { props: { children: textSnippet('Send') } });
    // ARIA's own guidance: absent, not "false", on a control that does not
    // toggle — a plain action button announced as an unpressed toggle is a
    // worse lie than saying nothing.
    expect(screen.getByTestId('ui-button').hasAttribute('aria-pressed')).toBe(false);
  });

  it('carries a toggle state in the accessibility tree, not only in a tint', () => {
    render(Button, { props: { children: textSnippet('Files'), pressed: false } });
    const button = screen.getByTestId('ui-button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.classList.contains('ui-button-pressed')).toBe(false);

    cleanup();
    render(Button, { props: { children: textSnippet('Files'), pressed: true } });
    const on = screen.getByTestId('ui-button');
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(on.classList.contains('ui-button-pressed')).toBe(true);
  });

  it('takes a hover tooltip, for a control whose visible word is hidden at some widths', () => {
    render(Button, {
      props: { children: textSnippet('Files'), ariaLabel: 'Files', title: 'Files' },
    });
    expect(screen.getByTestId('ui-button').getAttribute('title')).toBe('Files');
  });

  it('can take on a radiogroup member role (issue #549): role, aria-checked, tabindex and keydown all pass through', async () => {
    const onkeydown = vi.fn();
    render(Button, {
      props: {
        children: textSnippet('Plan'),
        role: 'radio',
        ariaChecked: true,
        tabindex: 0,
        onkeydown,
      },
    });
    const button = screen.getByTestId('ui-button');
    expect(button.getAttribute('role')).toBe('radio');
    expect(button.getAttribute('aria-checked')).toBe('true');
    // Never both: a radio's state lives in aria-checked, not aria-pressed.
    expect(button.hasAttribute('aria-pressed')).toBe(false);
    expect(button.tabIndex).toBe(0);
    await fireEvent.keyDown(button, { key: 'ArrowRight' });
    expect(onkeydown).toHaveBeenCalledTimes(1);
  });
});
