// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import BrandLockup from './BrandLockup.svelte';

afterEach(() => cleanup());

describe('BrandLockup (#194 wordmark lockup)', () => {
  it('renders the mark plus the full "loombox" wordmark text', () => {
    render(BrandLockup);
    const lockup = screen.getByTestId('brand-lockup');
    expect(lockup.querySelector('[data-testid="brand-mark"]')).toBeTruthy();
    expect(lockup.textContent?.trim()).toBe('loombox');
  });

  it('sets the wordmark in the mono font token', () => {
    render(BrandLockup);
    const wordmark = screen.getByTestId('brand-lockup').querySelector('.wordmark');
    expect(wordmark?.classList.contains('font-mono')).toBe(true);
  });

  it('colors exactly the double-o with the accent token, leaving the rest unstyled', () => {
    render(BrandLockup);
    const oo = screen.getByTestId('accent-oo');
    expect(oo.textContent).toBe('oo');
    expect(oo.style.color).toBe('var(--color-accent)');
  });
});
