import {
  PROTOCOL_V1,
  type TrackerRecordV1,
  type TrackerSnapshotRequest,
  type TrackerTypeDefinitionV1,
} from '@loombox/protocol';
import { expect, test } from './fixtures';
import { nodeSeal } from './harness/relay-harness';

/**
 * The native tracker's kanban board at the width it is actually promised
 * to work at (issue #212's explicit acceptance: "a real answer at 390px,
 * not a horizontal scroll nobody can use"). Mirrors
 * `inbox-mobile.spec.ts`'s shape: same fixture, same 390x844 viewport, a
 * real browser driving the real app against a fake node standing in for
 * `@loombox/node`'s wire handlers.
 */

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

const TASK_TYPE: TrackerTypeDefinitionV1 = {
  id: 'task',
  label: 'Task',
  builtin: true,
  roles: { title: 'title', workflowStatus: 'status', priority: 'priority', assignee: 'assignee' },
};

test.describe('Native tracker kanban board at 390px (issue #212)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('renders one column at a time with Prev/Next, no horizontal scroll, and every card fits the viewport', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    // The Tracker destination row lives inside the sidebar, which is an
    // off-canvas sheet at this width — reached via the tabbar, same as
    // `inbox-mobile.spec.ts`'s own note about `destination-inbox`.
    await page.getByTestId('tabbar-sessions').click();
    await page.getByTestId('destination-tracker').click();
    await expect(page.getByTestId('tracker-page')).toBeVisible();

    const request = (await loombox.node.waitFor(
      (message) => message.type === 'tracker_snapshot_request',
    )) as TrackerSnapshotRequest;

    const records: TrackerRecordV1[] = [
      {
        id: 'rec-todo',
        primaryType: 'task',
        typeTags: [],
        issueNumber: 1,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        fields: { title: 'Ship dark mode', status: 'todo', priority: 'high', assignee: 'ada' },
        system: makeSystem(),
      },
      {
        id: 'rec-done',
        primaryType: 'task',
        typeTags: [],
        issueNumber: 2,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        fields: { title: 'Ship light mode', status: 'done' },
        system: makeSystem(),
      },
    ];
    const envelope = await nodeSeal(
      loombox.session.sessionId,
      { outcome: 'ok', records, types: [TASK_TYPE] },
      loombox.session.key,
    );
    loombox.node.send({
      type: 'tracker_snapshot_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: loombox.session.sessionId,
      requestId: request.requestId,
      envelope,
    });

    await expect(page.getByTestId('tracker-board-mobile-nav')).toBeVisible();

    // Columns sort alphabetically ('done' before 'todo') — the mobile nav
    // starts on the first one, showing only that column's card.
    await expect(page.getByTestId('tracker-board-mobile-title')).toContainText('done');
    await expect(page.getByTestId('tracker-card-rec-done')).toBeVisible();
    await expect(page.getByTestId('tracker-card-rec-todo')).not.toBeVisible();

    // No horizontal scroll of narrow columns (issue #212's explicit
    // acceptance) — the board's own columns wrapper never exceeds the
    // viewport width it renders in.
    const columnsBox = await page.getByTestId('tracker-board-columns').boundingBox();
    expect(columnsBox).not.toBeNull();
    expect(columnsBox!.x).toBeGreaterThanOrEqual(0);
    expect(columnsBox!.x + columnsBox!.width).toBeLessThanOrEqual(390);

    const cardBox = await page.getByTestId('tracker-card-rec-done').boundingBox();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.x).toBeGreaterThanOrEqual(0);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(390);

    // Next switches the visible column — a real answer at this width, not
    // a horizontal scroll: the previous column's card disappears entirely
    // rather than merely scrolling off-screen.
    await page.getByRole('button', { name: 'Next column' }).click();
    await expect(page.getByTestId('tracker-board-mobile-title')).toContainText('todo');
    await expect(page.getByTestId('tracker-card-rec-todo')).toBeVisible();
    await expect(page.getByTestId('tracker-card-rec-done')).not.toBeVisible();

    // Prev goes back.
    await page.getByRole('button', { name: 'Previous column' }).click();
    await expect(page.getByTestId('tracker-board-mobile-title')).toContainText('done');
    await expect(page.getByTestId('tracker-card-rec-done')).toBeVisible();
  });
});
