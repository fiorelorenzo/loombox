// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import { APP_TAGLINE } from '$lib/constants';

import GateShell from './GateShell.svelte';

afterEach(() => cleanup());

function panelSnippet(testId: string) {
  return createRawSnippet(() => ({
    render: () => `<div data-testid="${testId}">panel</div>`,
  }));
}

describe('GateShell (the composition every pre-cockpit screen shares)', () => {
  it('frames the caller panel with the brand lockup, the tagline and the theme control', () => {
    render(GateShell, { props: { children: panelSnippet('gate-panel-content') } });

    expect(screen.getByTestId('gate-shell')).toBeTruthy();
    expect(screen.getByTestId('brand-lockup')).toBeTruthy();
    expect(screen.getByText(APP_TAGLINE)).toBeTruthy();
    expect(screen.getByTestId('gate-panel-content')).toBeTruthy();
    expect(screen.getByTestId('theme-toggle')).toBeTruthy();
  });

  it('draws the brand exactly once, where the gate screens used to draw it twice', () => {
    // The signed-out gate stacked `EmptyState`'s dimmed `BrandMark` ~110px
    // under the header lockup's own mark, and `OnboardingGate` added a third
    // copy of it. The shell owning the lockup is what makes "once" checkable.
    render(GateShell, { props: { children: panelSnippet('gate-panel-content') } });

    expect(screen.getAllByTestId('brand-mark')).toHaveLength(1);
  });

  it('renders a footer only when the screen supplies one', () => {
    render(GateShell, { props: { children: panelSnippet('gate-panel-content') } });
    expect(screen.queryByTestId('gate-footer-content')).toBeNull();

    cleanup();
    render(GateShell, {
      props: {
        children: panelSnippet('gate-panel-content'),
        footer: panelSnippet('gate-footer-content'),
      },
    });
    expect(screen.getByTestId('gate-footer-content')).toBeTruthy();
  });

  it('carries the column width as an attribute, so onboarding widens without a second layout', () => {
    render(GateShell, { props: { children: panelSnippet('gate-panel-content') } });
    expect(screen.getByTestId('gate-shell').dataset.width).toBe('panel');

    cleanup();
    render(GateShell, {
      props: { children: panelSnippet('gate-panel-content'), width: 'wide' },
    });
    expect(screen.getByTestId('gate-shell').dataset.width).toBe('wide');
  });
});
