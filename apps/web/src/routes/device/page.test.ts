import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Page from './+page.svelte';

describe('/device route (#387)', () => {
  it('renders the brand lockup and the device-approve card shell', () => {
    const { body } = render(Page);
    expect(body).toContain('data-testid="brand-lockup"');
    expect(body).toContain('Link a device');
    // SSR never runs onMount, so authChecked stays false and the
    // "checking session" state renders rather than the sign-in gate or the
    // approval form — proves the page doesn't crash before hydration.
    expect(body).toContain('Checking session');
    // The woven-thread loading motif (#274) backs that "checking session" wait.
    expect(body).toContain('data-testid="woven-loader"');
  });
});
