// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTrackerTypeRegistryV1,
  type TrackerRecordV1,
  type TrackerTypeDefinitionV1,
} from '@loombox/protocol';
import TrackerBoard from './TrackerBoard.svelte';

/**
 * The kanban board's three fixed workflow-category columns (issue #651,
 * v7 decision F4-2) — no prior suite covered `TrackerBoard.svelte`
 * directly (only the e2e specs drove it through a real browser), so this
 * is new coverage for a genuinely new contract: always three columns, in
 * workflow order, an empty one included, never one column per raw status.
 */

afterEach(() => cleanup());

const TASK_TYPE: TrackerTypeDefinitionV1 = {
  id: 'task',
  label: 'Task',
  builtin: true,
  roles: { title: 'title', workflowStatus: 'status', priority: 'priority', assignee: 'assignee' },
};

function makeSystem(): TrackerRecordV1['system'] {
  return {
    authorId: 'author-1',
    linkedCommitSha: [],
    linkedPullRequests: [],
    linkedSessionIds: [],
    activity: [],
    comments: [],
  };
}

function makeRecord(id: string, status: string, title: string): TrackerRecordV1 {
  return {
    id,
    primaryType: 'task',
    typeTags: [],
    issueNumber: 1,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    fields: { title, status },
    system: makeSystem(),
  };
}

const TYPES = buildTrackerTypeRegistryV1([TASK_TYPE]);

describe('TrackerBoard (issue #651, v7 decision F4-2 — three workflow-category columns)', () => {
  it('renders exactly the three category columns, in workflow order, even with zero records', () => {
    render(TrackerBoard, {
      props: { records: [], types: TYPES, onMove: vi.fn(), onOpen: vi.fn() },
    });

    const columnsEl = screen.getByTestId('tracker-board-columns');
    const sections = within(columnsEl).getAllByRole('region');
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual([
      'To Do',
      'In Progress',
      'Done',
    ]);
    expect(screen.getByTestId('tracker-board-column-new')).toBeTruthy();
    expect(screen.getByTestId('tracker-board-column-indeterminate')).toBeTruthy();
    expect(screen.getByTestId('tracker-board-column-done')).toBeTruthy();
  });

  it('buckets each record into its resolved category, never a raw-status column', () => {
    const todo = makeRecord('r1', 'todo', 'Ship dark mode');
    const done = makeRecord('r2', 'done', 'Already shipped');
    render(TrackerBoard, {
      props: { records: [todo, done], types: TYPES, onMove: vi.fn(), onOpen: vi.fn() },
    });

    expect(
      within(screen.getByTestId('tracker-board-column-new')).getByTestId('tracker-card-r1'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('tracker-board-column-done')).getByTestId('tracker-card-r2'),
    ).toBeTruthy();
    // No per-status column ever appears — 'todo'/'done' are field values,
    // not column identities, under the new grouping.
    expect(screen.queryByTestId('tracker-board-column-todo')).toBeNull();
  });

  it('an empty category column still renders and still accepts a drop, calling onMove with its category id', async () => {
    const todo = makeRecord('r1', 'todo', 'Ship dark mode');
    const onMove = vi.fn();
    render(TrackerBoard, {
      props: { records: [todo], types: TYPES, onMove, onOpen: vi.fn() },
    });

    // 'indeterminate' has zero records — exactly the "empty category
    // still renders and accepts a drop" acceptance criterion, the twin
    // defect the old per-status grouping had (a status with no records
    // never rendered a column at all).
    const emptyColumn = screen.getByTestId('tracker-board-column-indeterminate');
    expect(emptyColumn.querySelector('[data-testid^="tracker-card-"]')).toBeNull();

    await fireEvent.drop(emptyColumn, { dataTransfer: { getData: () => 'r1' } });

    expect(onMove).toHaveBeenCalledWith('r1', 'indeterminate');
  });

  it('mobile nav starts on "To Do" and Next reaches the empty "In Progress" column before "Done"', async () => {
    const todo = makeRecord('r1', 'todo', 'Ship dark mode');
    const done = makeRecord('r2', 'done', 'Already shipped');
    render(TrackerBoard, {
      props: { records: [todo, done], types: TYPES, onMove: vi.fn(), onOpen: vi.fn() },
    });

    // Every column stays in the DOM at every width (issue #212's own
    // design: mobile hides the other columns via CSS, it doesn't unmount
    // them) — the mobile-only pieces this test can verify without a real
    // viewport are the nav title/count and which column carries the
    // "hidden below 767px" class.
    const isMobileHidden = (testId: string) =>
      screen.getByTestId(testId).classList.contains('tracker-board-column-mobile-hidden');

    expect(screen.getByTestId('tracker-board-mobile-title').textContent).toMatch(/To Do/);
    expect(isMobileHidden('tracker-board-column-new')).toBe(false);
    expect(isMobileHidden('tracker-board-column-indeterminate')).toBe(true);
    expect(isMobileHidden('tracker-board-column-done')).toBe(true);

    const next = screen.getByRole('button', { name: 'Next column' }) as HTMLButtonElement;
    await fireEvent.click(next);
    // The empty middle column is still reachable, showing a real "0" —
    // never skipped as if it didn't exist.
    expect(screen.getByTestId('tracker-board-mobile-title').textContent).toMatch(/In Progress/);
    expect(screen.getByTestId('tracker-board-mobile-title').textContent).toMatch(/0/);
    expect(isMobileHidden('tracker-board-column-new')).toBe(true);
    expect(isMobileHidden('tracker-board-column-indeterminate')).toBe(false);
    expect(isMobileHidden('tracker-board-column-done')).toBe(true);

    await fireEvent.click(next);
    expect(screen.getByTestId('tracker-board-mobile-title').textContent).toMatch(/Done/);
    expect(isMobileHidden('tracker-board-column-done')).toBe(false);
    expect(next.disabled).toBe(true);
  });
});
