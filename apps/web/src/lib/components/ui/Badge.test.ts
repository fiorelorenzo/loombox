// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Badge from './Badge.svelte';

afterEach(() => cleanup());

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('Badge (issue #579 Warp Deck shared UI primitives)', () => {
  it('defaults to the neutral tone/small size and renders its children', () => {
    render(Badge, { props: { children: textSnippet('cli') } });
    const badge = screen.getByTestId('ui-badge');
    expect(badge.textContent).toContain('cli');
    expect(badge.getAttribute('data-tone')).toBe('neutral');
    expect(badge.classList.contains('ui-badge-neutral')).toBe(true);
    expect(badge.classList.contains('ui-badge-sm')).toBe(true);
    expect(badge.querySelector('[data-testid="ui-status-dot"]')).toBeNull();
  });

  it('applies each semantic tone', () => {
    for (const tone of ['neutral', 'success', 'warning', 'danger', 'info'] as const) {
      cleanup();
      render(Badge, { props: { children: textSnippet(tone), tone } });
      const badge = screen.getByTestId('ui-badge');
      expect(badge.getAttribute('data-tone')).toBe(tone);
      expect(badge.classList.contains(`ui-badge-${tone}`)).toBe(true);
    }
  });

  it('applies the size scale', () => {
    render(Badge, { props: { children: textSnippet('x'), size: 'md' } });
    expect(screen.getByTestId('ui-badge').classList.contains('ui-badge-md')).toBe(true);
  });

  it("composes the real StatusDot rather than redrawing it, at the badge's own tone", () => {
    render(Badge, {
      props: { children: textSnippet('Healthy'), tone: 'success', dot: true, dotLabel: 'Healthy' },
    });
    const badge = screen.getByTestId('ui-badge');
    const dot = badge.querySelector('[data-testid="ui-status-dot"]');
    expect(dot).toBeTruthy();
    expect(dot?.getAttribute('data-tone')).toBe('success');
    expect(dot?.getAttribute('aria-label')).toBe('Healthy');
  });

  it('merges a caller-provided class and lets a caller override the data-testid', () => {
    render(Badge, {
      props: { children: textSnippet('x'), class: 'kind-badge', dataTestId: 'target-kind-badge' },
    });
    expect(screen.queryByTestId('ui-badge')).toBeNull();
    const badge = screen.getByTestId('target-kind-badge');
    expect(badge.classList.contains('kind-badge')).toBe(true);
  });

  it('passes through arbitrary data-*/aria-* attributes, same escape hatch as Button/Row', () => {
    render(Badge, {
      props: { children: textSnippet('claude'), class: 'kind-badge', 'data-kind': 'claude' },
    });
    expect(screen.getByTestId('ui-badge').getAttribute('data-kind')).toBe('claude');
  });
});
