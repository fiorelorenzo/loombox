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
    // The woven-thread loading motif (#274) backs that "checking session" wait,
    // at the same panel size the sign-in gate uses — this page used to render
    // the 1em default inline with the text.
    expect(body).toContain('data-testid="woven-loader"');
    expect(body).toContain('data-size="md"');
  });

  it('shares the gate composition rather than hand-rolling its own header', () => {
    // This route had its own top-aligned `max-width` column plus a duplicate
    // lockup/tagline header, which is how it and the sign-in gate drifted
    // apart. `GateShell` owns the centring, the woven field and the brand now,
    // so the two screens land their panel in the same place.
    const { body } = render(Page);
    expect(body).toContain('data-testid="gate-shell"');
    // Exactly one brand mark: the lockup's own, not a second dimmed copy.
    expect(body.match(/data-testid="brand-mark"/g)).toHaveLength(1);
  });
});
