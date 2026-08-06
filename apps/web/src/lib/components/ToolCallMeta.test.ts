// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ToolCallMeta from './ToolCallMeta.svelte';

afterEach(() => cleanup());

describe('ToolCallMeta', () => {
  it('renders nothing at all when neither elapsed time nor an attributed cost is known (issue #744 shows-nothing case)', () => {
    const { container } = render(ToolCallMeta, {
      props: { elapsedMs: undefined, attributedCostUsd: undefined },
    });
    expect(screen.queryByTestId('tool-call-meta')).toBeNull();
    expect(container.textContent?.trim()).toBe('');
  });

  it('renders only the elapsed badge when there is no attributable cost', () => {
    render(ToolCallMeta, { props: { elapsedMs: 3200, attributedCostUsd: undefined } });
    expect(screen.getByText('3.2s')).toBeTruthy();
  });

  it('renders only the cost badge when the start was never observed (no elapsed time) but cost was still attributable', () => {
    render(ToolCallMeta, { props: { elapsedMs: undefined, attributedCostUsd: 0.04 } });
    expect(screen.getByText('$0.04')).toBeTruthy();
  });

  it('renders both badges together, elapsed time first', () => {
    const { getByTestId } = render(ToolCallMeta, {
      props: { elapsedMs: 450, attributedCostUsd: 0.0032 },
    });
    const meta = getByTestId('tool-call-meta');
    expect(meta.textContent?.replace(/\s+/g, '')).toBe('450ms$0.0032');
  });
});
