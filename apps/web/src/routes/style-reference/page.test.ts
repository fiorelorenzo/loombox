import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Page from './+page.svelte';

describe('style-reference route (#195/#196: living token/type reference)', () => {
  it('renders the color, spacing, and typography sections referencing real CSS custom properties', () => {
    const { body } = render(Page);

    // Color tokens (#195): background/surface/border ramp, text ramp, the
    // accent "thread", and the semantic status set.
    expect(body).toContain('var(--color-bg)');
    expect(body).toContain('var(--color-text-primary)');
    expect(body).toContain('var(--color-accent)');
    expect(body).toContain('var(--color-success)');
    expect(body).toContain('var(--color-warning)');
    expect(body).toContain('var(--color-danger)');
    expect(body).toContain('var(--color-info)');

    // Spacing/radius/elevation/z-index scales.
    expect(body).toContain('--space-md');
    expect(body).toContain('--radius-lg');
    expect(body).toContain('--shadow-md');

    // Typography (#196): both self-hosted faces and the type scale tokens
    // are demonstrated, not just named.
    expect(body).toContain('--font-ui');
    expect(body).toContain('--font-mono');
    expect(body).toContain('--text-display-size');
    expect(body).toContain('--text-code-size');
    expect(body).toContain('JetBrains Mono Variable');
    expect(body).toContain('Inter Variable');
  });

  it('renders a theme toggle wired to the shared theme store', () => {
    const { body } = render(Page);
    expect(body).toContain('data-testid="theme-toggle"');
  });

  it('demonstrates the woven-thread motif in both its loading and working states (#274)', () => {
    const { body } = render(Page);
    expect(body).toContain('woven-loader-loading');
    expect(body).toContain('woven-loader-working');
  });

  it('demonstrates the thread-draw motion primitive and the WovenLoader skeleton state (#429)', () => {
    const { body } = render(Page);

    // The SVG stroke form of the thread-draw utility (motion.css).
    expect(body).toContain('thread-draw-once');
    expect(body).toContain('thread-draw-loop');
    expect(body).toContain('--thread-draw-length');

    // The block-fill form.
    expect(body).toContain('thread-draw-fill');
    expect(body).toContain('thread-draw-fill-loop');
    expect(body).toContain('--thread-draw-progress');

    // The explicit reduced-motion escape hatch.
    expect(body).toContain('thread-draw-reduced-motion');

    // WovenLoader's additive skeleton variant, including reducedMotion.
    expect(body).toContain('woven-loader-skeleton');
    expect(body).toContain('data-reduced-motion="true"');
  });
});
