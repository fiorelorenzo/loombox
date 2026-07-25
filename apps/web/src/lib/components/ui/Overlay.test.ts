// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Overlay from './Overlay.svelte';

afterEach(() => cleanup());

function contentSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<button type="button" data-testid="overlay-content">${text}</button>`,
  }));
}

describe('Overlay (issue #461 shared overlay root)', () => {
  it('renders nothing while closed', () => {
    render(Overlay, {
      props: {
        open: false,
        onClose: vi.fn(),
        children: contentSnippet('Content'),
        reducedMotion: true,
      },
    });
    expect(screen.queryByTestId('overlay-backdrop')).toBeNull();
  });

  it('renders a backdrop plus the given children while open', () => {
    render(Overlay, {
      props: {
        open: true,
        onClose: vi.fn(),
        children: contentSnippet('Content'),
        reducedMotion: true,
      },
    });
    expect(screen.getByTestId('overlay-backdrop')).toBeTruthy();
    expect(screen.getByTestId('overlay-content')).toBeTruthy();
  });

  it('clicking the backdrop calls onClose', async () => {
    const onClose = vi.fn();
    render(Overlay, {
      props: {
        open: true,
        onClose,
        children: contentSnippet('Content'),
        reducedMotion: true,
      },
    });
    await fireEvent.click(screen.getByTestId('overlay-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape calls onClose', async () => {
    const onClose = vi.fn();
    render(Overlay, {
      props: {
        open: true,
        onClose,
        children: contentSnippet('Content'),
        reducedMotion: true,
      },
    });
    await fireEvent.keyDown(screen.getByTestId('overlay-backdrop'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('draws the backdrop at the given z-index token, defaulting to --z-overlay', () => {
    const { rerender } = render(Overlay, {
      props: {
        open: true,
        onClose: vi.fn(),
        children: contentSnippet('Content'),
        reducedMotion: true,
      },
    });
    expect(screen.getByTestId('overlay-backdrop').style.zIndex).toBe('var(--z-overlay)');

    rerender({
      open: true,
      onClose: vi.fn(),
      children: contentSnippet('Content'),
      reducedMotion: true,
      zIndex: '--z-modal',
    });
    expect(screen.getByTestId('overlay-backdrop').style.zIndex).toBe('var(--z-modal)');
  });

  it('supports a testid override, so callers with an existing selector keep it unchanged', () => {
    render(Overlay, {
      props: {
        open: true,
        onClose: vi.fn(),
        children: contentSnippet('Content'),
        reducedMotion: true,
        testid: 'dialog-backdrop',
      },
    });
    expect(screen.getByTestId('dialog-backdrop')).toBeTruthy();
    expect(screen.queryByTestId('overlay-backdrop')).toBeNull();
  });
});
