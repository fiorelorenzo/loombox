import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Page from './+page.svelte';
import { APP_NAME } from '$lib/constants';

describe('shell +page.svelte', () => {
  it('renders the loombox heading as the brand lockup (issue #194)', () => {
    const { body } = render(Page);
    expect(body).toContain('<h1');
    expect(body).toContain('data-testid="brand-lockup"');
    expect(body).toContain('data-testid="brand-mark"');
    // The wordmark's "oo" is split into its own styled span (BrandLockup.svelte),
    // so strip tags before checking the rendered brand name reads intact.
    expect(body.replace(/<[^>]+>/g, '')).toContain(APP_NAME);
  });
});
