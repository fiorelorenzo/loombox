// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ToolCard from './ToolCard.svelte';

afterEach(() => cleanup());

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('ToolCard: one level of card chrome, not two (issue #576)', () => {
  it('draws the border/background surface when surface is true', () => {
    render(ToolCard, { props: { surface: true, children: textSnippet('checklist body') } });
    const card = screen.getByTestId('tool-card');
    expect(card.classList.contains('tool-card-surface')).toBe(true);
    expect(card.classList.contains('tool-card-plain')).toBe(false);
    expect(card.getAttribute('data-surface')).toBe('true');
  });

  it("draws no border/background when surface is false, so a bespoke widget's own surface stays the only chrome", () => {
    render(ToolCard, { props: { surface: false, children: textSnippet('terminal body') } });
    const card = screen.getByTestId('tool-card');
    expect(card.classList.contains('tool-card-plain')).toBe(true);
    expect(card.classList.contains('tool-card-surface')).toBe(false);
    expect(card.getAttribute('data-surface')).toBe('false');
  });

  it('always renders its children regardless of the surface choice', () => {
    render(ToolCard, { props: { surface: false, children: textSnippet('plain content') } });
    expect(screen.getByText('plain content')).toBeTruthy();
  });

  it('merges a caller-provided class onto the root element in both surface modes', () => {
    render(ToolCard, {
      props: { surface: true, class: 'my-extra', children: textSnippet('x') },
    });
    expect(screen.getByTestId('tool-card').classList.contains('my-extra')).toBe(true);
  });
});
