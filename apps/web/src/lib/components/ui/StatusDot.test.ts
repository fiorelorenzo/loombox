// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import StatusDot from './StatusDot.svelte';

afterEach(() => cleanup());

describe('StatusDot (issue #428 Warp Deck shared UI primitives)', () => {
  it('renders as an accessible, labeled status marker defaulting to neutral/no pulse', () => {
    render(StatusDot, { props: { label: 'Idle' } });
    const dot = screen.getByTestId('ui-status-dot');
    expect(dot.getAttribute('role')).toBe('img');
    expect(dot.getAttribute('aria-label')).toBe('Idle');
    expect(dot.getAttribute('data-tone')).toBe('neutral');
    expect(dot.getAttribute('data-pulse')).toBe('false');
    expect(screen.queryByTestId('ui-status-dot-ring')).toBeNull();
  });

  it('applies each semantic tone', () => {
    for (const tone of ['neutral', 'success', 'warning', 'danger', 'info'] as const) {
      cleanup();
      render(StatusDot, { props: { label: tone, tone } });
      expect(screen.getByTestId('ui-status-dot').getAttribute('data-tone')).toBe(tone);
    }
  });

  it('renders the thread-draw ring only when pulsing (e.g. a working session)', () => {
    render(StatusDot, { props: { label: 'Working', tone: 'info', pulse: true } });
    const dot = screen.getByTestId('ui-status-dot');
    expect(dot.getAttribute('data-pulse')).toBe('true');
    expect(screen.getByTestId('ui-status-dot-ring')).toBeTruthy();
  });

  it('exposes an explicit reduced-motion override for callers/tests, on top of the automatic prefers-reduced-motion media query (mirrors WovenLoader, issue #274)', () => {
    render(StatusDot, { props: { label: 'Working', pulse: true } });
    expect(screen.getByTestId('ui-status-dot').getAttribute('data-reduced-motion')).toBe('false');

    cleanup();
    render(StatusDot, { props: { label: 'Working', pulse: true, reducedMotion: true } });
    expect(screen.getByTestId('ui-status-dot').getAttribute('data-reduced-motion')).toBe('true');
  });

  it('supports a standalone medium size', () => {
    render(StatusDot, { props: { label: 'Healthy', size: 'md' } });
    expect(screen.getByTestId('ui-status-dot').classList.contains('ui-status-dot-md')).toBe(true);
  });
});
