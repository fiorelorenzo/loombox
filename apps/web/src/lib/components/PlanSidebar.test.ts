// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpPlanEntry } from '@loombox/providers-core/browser';
import PlanSidebar from './PlanSidebar.svelte';

afterEach(() => cleanup());

const entries: AcpPlanEntry[] = [
  { content: 'Read the spec', status: 'completed' },
  { content: 'Write the code', status: 'in_progress' },
  { content: 'Ship it', status: 'pending' },
  { content: 'Write the tests', status: 'pending' },
];

describe('PlanSidebar: grouping and the completion figure (issue #201)', () => {
  it('groups entries by status, in pending/in-progress/completed order, each labeled with its own count', () => {
    render(PlanSidebar, { props: { entries, collapsed: false, onToggle: vi.fn() } });

    const groups = screen.getAllByText(/Pending|In progress|Completed/, {
      selector: '.group-label',
    });
    expect(groups.map((el) => el.textContent)).toEqual([
      'Pending · 2',
      'In progress · 1',
      'Completed · 1',
    ]);
  });

  it('renders the same "N of M" completed-of-total figure PlanCard computes from the identical entries — both read $lib/plan.ts\'s planProgress', () => {
    render(PlanSidebar, { props: { entries, collapsed: false, onToggle: vi.fn() } });
    expect(screen.getByTestId('plan-sidebar-progress').textContent).toBe('1/4');
  });

  it('drives the completion bar off the same figure (25% here: 1 of 4 completed)', () => {
    render(PlanSidebar, { props: { entries, collapsed: false, onToggle: vi.fn() } });
    const meter = screen.getByTestId('plan-sidebar-meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('25');
    const fill = meter.querySelector('.meter-fill') as HTMLElement;
    expect(fill.style.getPropertyValue('--thread-draw-progress')).toBe('25%');
  });

  it('never renders a status group that has no entries — no empty section for a plan with nothing pending', () => {
    const allDone: AcpPlanEntry[] = entries.map((entry) => ({ ...entry, status: 'completed' }));
    render(PlanSidebar, { props: { entries: allDone, collapsed: false, onToggle: vi.fn() } });

    expect(screen.queryByTestId('plan-sidebar-group-pending')).toBeNull();
    expect(screen.queryByTestId('plan-sidebar-group-in_progress')).toBeNull();
    expect(screen.getByTestId('plan-sidebar-group-completed')).toBeTruthy();
  });

  it('an empty plan renders the header (0/0) but no groups at all — the caller is what decides whether to mount this component, this just never fabricates a scaffold for zero entries', () => {
    render(PlanSidebar, { props: { entries: [], collapsed: false, onToggle: vi.fn() } });
    expect(screen.getByTestId('plan-sidebar-progress').textContent).toBe('0/0');
    expect(screen.queryByTestId('plan-sidebar-group-pending')).toBeNull();
    expect(screen.queryByTestId('plan-sidebar-group-in_progress')).toBeNull();
    expect(screen.queryByTestId('plan-sidebar-group-completed')).toBeNull();
  });
});

describe('PlanSidebar: shimmer while active (mirrors PlanCard)', () => {
  it('shimmers while any entry is not completed, and settles once every entry is', () => {
    const { rerender } = render(PlanSidebar, {
      props: { entries, collapsed: false, onToggle: vi.fn() },
    });
    expect(screen.getByTestId('plan-sidebar-shimmer')).toBeTruthy();

    const done: AcpPlanEntry[] = entries.map((entry) => ({ ...entry, status: 'completed' }));
    rerender({ entries: done, collapsed: false, onToggle: vi.fn() });
    expect(screen.queryByTestId('plan-sidebar-shimmer')).toBeNull();
  });
});

describe('PlanSidebar: collapsible, remembering the caller-owned state (mirrors PlanCard)', () => {
  it('calls onToggle when the header is clicked, and hides the groups while collapsed', () => {
    const onToggle = vi.fn();
    const { rerender } = render(PlanSidebar, { props: { entries, collapsed: false, onToggle } });

    expect(screen.getByTestId('plan-sidebar-group-pending')).toBeTruthy();
    screen.getByRole('button', { name: 'Collapse plan' }).click();
    expect(onToggle).toHaveBeenCalledOnce();

    rerender({ entries, collapsed: true, onToggle });
    expect(screen.queryByTestId('plan-sidebar-group-pending')).toBeNull();
    // The header (progress figure, meter) stays visible while collapsed —
    // collapsing hides the entry list, not the whole persistent surface.
    expect(screen.getByTestId('plan-sidebar-progress').textContent).toBe('1/4');
  });
});

describe('PlanSidebar: updates in place without flicker (issue #201 explicit requirement)', () => {
  it('an entry unchanged between two plan_updates keeps its exact DOM node identity — no unnecessary remount', () => {
    const { rerender, container } = render(PlanSidebar, {
      props: { entries, collapsed: false, onToggle: vi.fn() },
    });

    const pendingBefore = container.querySelectorAll(
      '[data-testid="plan-sidebar-group-pending"] li',
    );
    expect(pendingBefore).toHaveLength(2);
    const shipItNodeBefore = Array.from(pendingBefore).find((li) =>
      li.textContent?.includes('Ship it'),
    );
    expect(shipItNodeBefore).toBeTruthy();

    // A fresh array (ACP replaces the whole plan wholesale on every
    // plan_update — never diffed client-side) where only "Write the code"
    // finishes; "Ship it" stays pending, same content, same original index.
    const next: AcpPlanEntry[] = entries.map((entry) =>
      entry.content === 'Write the code' ? { ...entry, status: 'completed' } : entry,
    );
    rerender({ entries: next, collapsed: false, onToggle: vi.fn() });

    const pendingAfter = container.querySelectorAll(
      '[data-testid="plan-sidebar-group-pending"] li',
    );
    const shipItNodeAfter = Array.from(pendingAfter).find((li) =>
      li.textContent?.includes('Ship it'),
    );
    // Keyed by original array index (`$lib/plan.ts`'s KeyedPlanEntry) —
    // an entry that neither changed status nor position is the same
    // element, not a torn-down-and-rebuilt replacement.
    expect(shipItNodeAfter).toBe(shipItNodeBefore);
  });

  it('reflects the latest plan, in place, as an entry moves from in_progress to completed', () => {
    const { rerender } = render(PlanSidebar, {
      props: { entries, collapsed: false, onToggle: vi.fn() },
    });
    expect(screen.getByTestId('plan-sidebar-progress').textContent).toBe('1/4');
    expect(screen.getByTestId('plan-sidebar-group-in_progress')).toBeTruthy();

    const next: AcpPlanEntry[] = entries.map((entry) =>
      entry.content === 'Write the code' ? { ...entry, status: 'completed' } : entry,
    );
    rerender({ entries: next, collapsed: false, onToggle: vi.fn() });

    expect(screen.getByTestId('plan-sidebar-progress').textContent).toBe('2/4');
    expect(screen.queryByTestId('plan-sidebar-group-in_progress')).toBeNull();
    const completedGroup = screen.getByTestId('plan-sidebar-group-completed');
    expect(completedGroup.textContent).toContain('Write the code');
  });

  it('never calls .focus() or renders an autofocus element — a mid-turn update cannot steal focus from wherever the user is typing', () => {
    const { container, rerender } = render(PlanSidebar, {
      props: { entries, collapsed: false, onToggle: vi.fn() },
    });
    expect(container.querySelector('[autofocus]')).toBeNull();

    const next: AcpPlanEntry[] = entries.map((entry) => ({ ...entry, status: 'completed' }));
    rerender({ entries: next, collapsed: false, onToggle: vi.fn() });
    expect(container.querySelector('[autofocus]')).toBeNull();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });
});
