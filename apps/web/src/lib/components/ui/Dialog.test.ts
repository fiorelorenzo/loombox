// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dialog from './Dialog.svelte';

afterEach(() => cleanup());

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<p>${text}</p>` }));
}

function buttonsSnippet(labels: string[]) {
  return createRawSnippet(() => ({
    render: () => `<div>${labels.map((l) => `<button type="button">${l}</button>`).join('')}</div>`,
  }));
}

describe('Dialog (issue #428 Warp Deck shared UI primitives)', () => {
  it('renders nothing while closed', () => {
    render(Dialog, {
      props: {
        open: false,
        label: 'Test dialog',
        onClose: vi.fn(),
        children: textSnippet('Body'),
        reducedMotion: true,
      },
    });
    expect(screen.queryByTestId('dialog')).toBeNull();
    expect(screen.queryByTestId('dialog-backdrop')).toBeNull();
  });

  it('renders the backdrop + a role=dialog panel with the given accessible name while open', () => {
    render(Dialog, {
      props: {
        open: true,
        label: 'New session',
        onClose: vi.fn(),
        children: textSnippet('Body'),
        reducedMotion: true,
      },
    });
    const dialog = screen.getByTestId('dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('New session');
    expect(screen.getByTestId('dialog-backdrop')).toBeTruthy();
  });

  it('renders header/body/footer content when provided', () => {
    render(Dialog, {
      props: {
        open: true,
        label: 'New session',
        onClose: vi.fn(),
        header: textSnippet('Header text'),
        children: textSnippet('Body text'),
        footer: textSnippet('Footer text'),
        reducedMotion: true,
      },
    });
    expect(screen.getByText('Header text')).toBeTruthy();
    expect(screen.getByText('Body text')).toBeTruthy();
    expect(screen.getByText('Footer text')).toBeTruthy();
  });

  it('Escape calls onClose', async () => {
    const onClose = vi.fn();
    render(Dialog, {
      props: {
        open: true,
        label: 'Test dialog',
        onClose,
        children: textSnippet('Body'),
        reducedMotion: true,
      },
    });
    await fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the backdrop calls onClose; clicking inside the panel does not', async () => {
    const onClose = vi.fn();
    render(Dialog, {
      props: {
        open: true,
        label: 'Test dialog',
        onClose,
        children: textSnippet('Body'),
        reducedMotion: true,
      },
    });
    await fireEvent.click(screen.getByTestId('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByTestId('dialog-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the panel on open and traps Tab/Shift+Tab between the first and last focusable elements', async () => {
    render(Dialog, {
      props: {
        open: true,
        label: 'Test dialog',
        onClose: vi.fn(),
        children: buttonsSnippet(['First', 'Second', 'Last']),
        reducedMotion: true,
      },
    });
    await tick();
    const dialog = screen.getByTestId('dialog');
    const buttons = within(dialog).getAllByRole('button');
    expect(document.activeElement).toBe(buttons[0]);

    buttons[buttons.length - 1].focus();
    await fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);

    await fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('restores focus to the previously-focused element once closed', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open';
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(Dialog, {
      props: {
        open: true,
        label: 'Test dialog',
        onClose: vi.fn(),
        children: textSnippet('Body'),
        reducedMotion: true,
      },
    });
    await tick();
    expect(document.activeElement).not.toBe(trigger);

    await rerender({
      open: false,
      label: 'Test dialog',
      onClose: vi.fn(),
      children: textSnippet('Body'),
      reducedMotion: true,
    });
    await tick();
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });
});
