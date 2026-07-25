// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Icon from './Icon.svelte';
import { ICON_NAMES, type IconName } from './icon-paths';

afterEach(() => cleanup());

describe('Icon (#457 bespoke hand-drawn icon set)', () => {
  describe.each(ICON_NAMES)('name lookup: "%s"', (name) => {
    it('draws its glyph inside the BrandMark stroke convention', () => {
      render(Icon, { props: { name } });
      const svg = screen.getByTestId('icon');
      expect(svg.tagName.toLowerCase()).toBe('svg');
      expect(svg.getAttribute('viewBox')).toBe('0 0 64 64');
      expect(svg.getAttribute('fill')).toBe('none');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.getAttribute('stroke-width')).toBe('3.4');
      expect(svg.getAttribute('stroke-linecap')).toBe('round');
      expect(svg.getAttribute('data-icon-name')).toBe(name);

      // Every path inherits the root's stroke presentation attributes —
      // none may override them per-path, which is what actually keeps the
      // whole set visually consistent with BrandMark's mark.
      const paths = svg.querySelectorAll('path');
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path.hasAttribute('stroke-width')).toBe(false);
        expect(path.hasAttribute('stroke-linecap')).toBe(false);
        expect(path.hasAttribute('stroke')).toBe(false);
        expect(path.hasAttribute('fill')).toBe(false);
        expect(path.getAttribute('d')).toBeTruthy();
      }
    });
  });

  it('is decorative (aria-hidden) by default', () => {
    render(Icon, { props: { name: 'close' } });
    const svg = screen.getByTestId('icon');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.hasAttribute('aria-label')).toBe(false);
    expect(svg.hasAttribute('role')).toBe(false);
  });

  it('exposes an accessible label when one is passed, and drops aria-hidden', () => {
    render(Icon, { props: { name: 'close', label: 'Close' } });
    const svg = screen.getByRole('img', { name: 'Close' });
    expect(svg.hasAttribute('aria-hidden')).toBe(false);
    expect(svg.getAttribute('aria-label')).toBe('Close');
  });

  it('falls back to a generic glyph for an unrecognized name instead of throwing', () => {
    expect(() => {
      render(Icon, { props: { name: 'not-a-real-icon' as IconName } });
    }).not.toThrow();
    const svg = screen.getByTestId('icon');
    const paths = svg.querySelectorAll('path');
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.getAttribute('d')).toBeTruthy();
    }
  });

  it('defaults size to 1em, matching BrandMark', () => {
    render(Icon, { props: { name: 'close' } });
    const svg = screen.getByTestId('icon');
    expect(svg.getAttribute('width')).toBe('1em');
    expect(svg.getAttribute('height')).toBe('1em');
  });

  it('applies a numeric size prop as the rendered width/height', () => {
    render(Icon, { props: { name: 'close', size: 24 } });
    const svg = screen.getByTestId('icon');
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('height')).toBe('24');
  });

  it('merges a caller-provided class onto the root svg', () => {
    render(Icon, { props: { name: 'close', class: 'rail-icon' } });
    const svg = screen.getByTestId('icon');
    expect(svg.classList.contains('icon')).toBe(true);
    expect(svg.classList.contains('rail-icon')).toBe(true);
  });
});
