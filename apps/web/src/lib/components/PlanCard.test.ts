// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpPlanEntry } from '@loombox/providers-core';
import PlanCard from './PlanCard.svelte';

afterEach(() => cleanup());

const entries: AcpPlanEntry[] = [
  { content: 'Read the spec', status: 'completed' },
  { content: 'Write the code', status: 'in_progress' },
  { content: 'Ship it', status: 'pending' },
];

describe('PlanCard', () => {
  it('renders the full entry list wholesale, replacing the previous render (never merged/diffed)', () => {
    const { rerender } = render(PlanCard, {
      props: { entries, collapsed: false, onToggle: vi.fn() },
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    rerender({
      entries: [{ content: 'Only this now', status: 'pending' }],
      collapsed: false,
      onToggle: vi.fn(),
    });
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Only this now');
  });

  it('shimmers while any entry is not completed, and settles once every entry is', () => {
    const { rerender } = render(PlanCard, {
      props: { entries, collapsed: false, onToggle: vi.fn() },
    });
    expect(screen.getByTestId('plan-shimmer')).toBeTruthy();

    const done: AcpPlanEntry[] = entries.map((entry) => ({ ...entry, status: 'completed' }));
    rerender({ entries: done, collapsed: false, onToggle: vi.fn() });
    expect(screen.queryByTestId('plan-shimmer')).toBeNull();
  });

  it('is collapsible and calls onToggle when the header is clicked', async () => {
    const onToggle = vi.fn();
    render(PlanCard, { props: { entries, collapsed: false, onToggle } });

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    screen.getByRole('button', { name: 'Collapse plan' }).click();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('hides the entry list while collapsed', () => {
    render(PlanCard, { props: { entries, collapsed: true, onToggle: vi.fn() } });
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});
