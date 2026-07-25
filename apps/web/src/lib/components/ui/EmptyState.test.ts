// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import EmptyState from './EmptyState.svelte';

afterEach(() => cleanup());

function ctaSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<button type="button">${text}</button>`,
  }));
}

describe('EmptyState (issue #428 Warp Deck shared UI primitives)', () => {
  it('renders the dimmed BrandMark and the explanation message', () => {
    render(EmptyState, { props: { message: 'No sessions yet.' } });
    const root = screen.getByTestId('ui-empty-state');
    expect(root.querySelector('[data-testid="brand-mark"]')).toBeTruthy();
    expect(screen.getByText('No sessions yet.')).toBeTruthy();
  });

  it('omits the CTA region when no cta snippet is provided', () => {
    render(EmptyState, { props: { message: 'No sessions yet.' } });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the caller-supplied CTA slot when provided', () => {
    render(EmptyState, {
      props: { message: 'No targets connected yet.', cta: ctaSnippet('Add a target') },
    });
    expect(screen.getByRole('button', { name: 'Add a target' })).toBeTruthy();
  });
});
