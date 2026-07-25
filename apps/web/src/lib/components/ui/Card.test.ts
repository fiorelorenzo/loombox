// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Card from './Card.svelte';

afterEach(() => cleanup());

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<p>${text}</p>` }));
}

describe('Card (issue #428 Warp Deck shared UI primitives)', () => {
  it('defaults to the flat elevation tier and renders its children', () => {
    render(Card, { props: { children: textSnippet('Row content') } });
    const card = screen.getByTestId('ui-card');
    expect(card.getAttribute('data-elevation')).toBe('flat');
    expect(card.classList.contains('ui-card-flat')).toBe(true);
    expect(card.textContent).toContain('Row content');
  });

  it('maps the elevation prop to exactly the flat/raised/floating ladder', () => {
    for (const elevation of ['flat', 'raised', 'floating'] as const) {
      cleanup();
      render(Card, { props: { children: textSnippet('x'), elevation } });
      const card = screen.getByTestId('ui-card');
      expect(card.getAttribute('data-elevation')).toBe(elevation);
      expect(card.classList.contains(`ui-card-${elevation}`)).toBe(true);
    }
  });

  it('applies the padding scale', () => {
    render(Card, { props: { children: textSnippet('x'), padding: 'none' } });
    expect(screen.getByTestId('ui-card').classList.contains('ui-card-padding-none')).toBe(true);
  });

  it('merges a caller-provided class onto the root element', () => {
    render(Card, { props: { children: textSnippet('x'), class: 'session-row' } });
    expect(screen.getByTestId('ui-card').classList.contains('session-row')).toBe(true);
  });
});
