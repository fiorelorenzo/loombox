// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IconButton from './IconButton.svelte';

afterEach(() => cleanup());

function iconSnippet() {
  return createRawSnippet(() => ({
    render: () => '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="4" /></svg>',
  }));
}

describe('IconButton (issue #428 Warp Deck shared UI primitives)', () => {
  it('exposes the icon-only accessible name via label/aria-label/title', () => {
    render(IconButton, { props: { label: 'Open inbox', children: iconSnippet() } });
    const button = screen.getByRole('button', { name: 'Open inbox' });
    expect(button.getAttribute('title')).toBe('Open inbox');
  });

  it('does not set aria-pressed for a plain, non-toggling action', () => {
    render(IconButton, { props: { label: 'Command palette', children: iconSnippet() } });
    expect(screen.getByTestId('ui-icon-button').hasAttribute('aria-pressed')).toBe(false);
  });

  it('sets aria-pressed and the accent-subtle treatment when pressed is a real toggle state', () => {
    render(IconButton, {
      props: { label: 'Pin drawer', pressed: true, children: iconSnippet() },
    });
    const button = screen.getByTestId('ui-icon-button');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.classList.contains('ui-icon-button-pressed')).toBe(true);

    cleanup();
    render(IconButton, {
      props: { label: 'Pin drawer', pressed: false, children: iconSnippet() },
    });
    const unpressed = screen.getByTestId('ui-icon-button');
    expect(unpressed.getAttribute('aria-pressed')).toBe('false');
    expect(unpressed.classList.contains('ui-icon-button-pressed')).toBe(false);
  });

  it('fires onclick and respects disabled', async () => {
    const onclick = vi.fn();
    render(IconButton, { props: { label: 'Refresh', onclick, children: iconSnippet() } });
    await fireEvent.click(screen.getByTestId('ui-icon-button'));
    expect(onclick).toHaveBeenCalledTimes(1);

    cleanup();
    const disabledOnclick = vi.fn();
    render(IconButton, {
      props: {
        label: 'Refresh',
        onclick: disabledOnclick,
        disabled: true,
        children: iconSnippet(),
      },
    });
    const button = screen.getByTestId('ui-icon-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('renders a badge when provided (e.g. Inbox unread count, unhealthy target flag)', () => {
    render(IconButton, { props: { label: 'Inbox', badge: 3, children: iconSnippet() } });
    expect(screen.getByTestId('ui-icon-button-badge').textContent).toBe('3');

    cleanup();
    render(IconButton, { props: { label: 'Inbox', children: iconSnippet() } });
    expect(screen.queryByTestId('ui-icon-button-badge')).toBeNull();
  });
});
