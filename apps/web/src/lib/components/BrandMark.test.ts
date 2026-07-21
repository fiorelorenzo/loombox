// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import BrandMark from './BrandMark.svelte';

afterEach(() => cleanup());

describe('BrandMark (#194 "Warp & Weft" mark)', () => {
  it('renders the locked-geometry inline SVG with a currentColor stroke', () => {
    render(BrandMark);
    const svg = screen.getByTestId('brand-mark');
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 64 64');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.querySelector('rect')).toBeTruthy();
    expect(svg.querySelectorAll('path')).toHaveLength(8);
  });

  it('is decorative (aria-hidden) by default, since it is always paired with visible text', () => {
    render(BrandMark);
    const svg = screen.getByTestId('brand-mark');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.hasAttribute('aria-label')).toBe(false);
  });

  it('exposes an accessible label when decorative is turned off', () => {
    render(BrandMark, { props: { decorative: false, label: 'loombox' } });
    const svg = screen.getByRole('img', { name: 'loombox' });
    expect(svg.hasAttribute('aria-hidden')).toBe(false);
  });

  it('merges a caller-provided class onto the root svg', () => {
    render(BrandMark, { props: { class: 'header-mark' } });
    const svg = screen.getByTestId('brand-mark');
    expect(svg.classList.contains('brand-mark')).toBe(true);
    expect(svg.classList.contains('header-mark')).toBe(true);
  });
});
