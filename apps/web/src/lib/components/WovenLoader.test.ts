// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import WovenLoader from './WovenLoader.svelte';

afterEach(() => cleanup());

describe('WovenLoader (#274 woven-thread loading/working motif)', () => {
  it('renders as an accessible status region with the woven-thread SVG', () => {
    render(WovenLoader);
    const root = screen.getByTestId('woven-loader');
    expect(root.getAttribute('role')).toBe('status');
    expect(root.getAttribute('aria-label')).toBe('Loading');
    const svg = root.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.querySelectorAll('path.thread')).toHaveLength(5);
  });

  it('defaults to the small, loading variant', () => {
    render(WovenLoader);
    const root = screen.getByTestId('woven-loader');
    expect(root.getAttribute('data-size')).toBe('sm');
    expect(root.getAttribute('data-variant')).toBe('loading');
    expect(root.classList.contains('woven-loader-sm')).toBe(true);
    expect(root.classList.contains('woven-loader-loading')).toBe(true);
  });

  it('accepts a medium panel size and a continuous "working" variant', () => {
    render(WovenLoader, { props: { size: 'md', variant: 'working' } });
    const root = screen.getByTestId('woven-loader');
    expect(root.getAttribute('data-size')).toBe('md');
    expect(root.getAttribute('data-variant')).toBe('working');
    expect(root.classList.contains('woven-loader-md')).toBe(true);
    expect(root.classList.contains('woven-loader-working')).toBe(true);
  });

  it('accepts a custom accessible label', () => {
    render(WovenLoader, { props: { label: 'Connecting to the relay' } });
    expect(screen.getByRole('status', { name: 'Connecting to the relay' })).toBeTruthy();
  });

  it('exposes an explicit reduced-motion override for callers/tests, on top of the automatic prefers-reduced-motion media query', () => {
    render(WovenLoader);
    expect(screen.getByTestId('woven-loader').getAttribute('data-reduced-motion')).toBe('false');

    cleanup();
    render(WovenLoader, { props: { reducedMotion: true } });
    expect(screen.getByTestId('woven-loader').getAttribute('data-reduced-motion')).toBe('true');
  });

  it('merges a caller-provided class onto the root element', () => {
    render(WovenLoader, { props: { class: 'inline-loader' } });
    const root = screen.getByTestId('woven-loader');
    expect(root.classList.contains('woven-loader')).toBe(true);
    expect(root.classList.contains('inline-loader')).toBe(true);
  });
});
